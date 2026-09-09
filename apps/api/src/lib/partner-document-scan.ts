import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getDb,
  mediaAssets,
  auditLogs,
  partnerJobEvidence,
  outboxEvents,
} from "@/db";
import { getMediaObject, putImmutableMediaObject } from "@/lib/media-storage";

export const MAX_PARTNER_PDF_BYTES = 10 * 1024 * 1024;
export function isPartnerDocumentScanningConfigured(): boolean {
  return Boolean(
    process.env["PARTNER_CLAMAV_SOCKET"]?.trim() ||
      process.env["PARTNER_CLAMAV_HOST"]?.trim(),
  );
}

export function hasPartnerPdfSignature(bytes: Buffer): boolean {
  return (
    bytes.length > 12 &&
    bytes.length <= MAX_PARTNER_PDF_BYTES &&
    /^%PDF-[12]\.[0-9]/u.test(bytes.subarray(0, 8).toString("ascii")) &&
    bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
  );
}

/** ClamD has no transport authentication. Configure a private socket/network, never a public endpoint. */
export async function scanPartnerPdfBytes(
  bytes: Buffer,
): Promise<"clean" | "infected"> {
  const socketPath = process.env["PARTNER_CLAMAV_SOCKET"]?.trim();
  const host = process.env["PARTNER_CLAMAV_HOST"]?.trim();
  const port = Number(process.env["PARTNER_CLAMAV_PORT"] ?? "3310");
  if (
    (!socketPath && !host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("partner_document_scanner_unconfigured");
  if (!hasPartnerPdfSignature(bytes))
    throw new Error("partner_document_signature_invalid");
  const socket = socketPath
    ? connect(socketPath)
    : connect({ host: host!, port });
  const deadline = setTimeout(
    () => socket.destroy(new Error("partner_document_scan_timeout")),
    45_000,
  );
  let reply = Buffer.alloc(0);
  const result = new Promise<"clean" | "infected">((resolve, reject) => {
    socket.on("error", () =>
      reject(new Error("partner_document_scanner_unavailable")),
    );
    socket.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > 4096)
        socket.destroy(new Error("partner_document_scan_response_invalid"));
    });
    socket.on("close", () => {
      const text = reply.toString("utf8");
      if (text === "stream: OK\0") resolve("clean");
      else if (
        text.endsWith(" FOUND\0") &&
        !text.slice(0, -1).includes("\0") &&
        /^stream: [^\r\n]+ FOUND$/u.test(text.slice(0, -1))
      )
        resolve("infected");
      else reject(new Error("partner_document_scan_not_clean"));
    });
  });
  // Attach the rejection handler before sending, so a connect failure cannot become an unhandled rejection.
  void result.catch(() => undefined);
  try {
    await once(socket, "connect");
    socket.write("zINSTREAM\0");
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length);
      socket.write(length);
      if (!socket.write(chunk)) await once(socket, "drain");
    }
    socket.write(Buffer.alloc(4));
    return await result;
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

/** Durable outbox retries leave quarantined bytes unreadable; only a clean result can publish this asset. */
export async function processPartnerDocumentScan(input: {
  assetId: string;
  accountId: string;
}): Promise<void> {
  const db = getDb();
  const claim = randomUUID();
  const asset = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, input.assetId),
          eq(mediaAssets.partnerAccountId, input.accountId),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !row ||
      row.sourceMetadata?.["scanStatus"] === "clean" ||
      row.sourceMetadata?.["scanStatus"] === "infected"
    )
      return null;
    if (
      row.contentType !== "application/pdf" ||
      row.sourceMetadata?.["scanStatus"] !== "queued" ||
      !row.originalObjectKey.startsWith(
        `partner/quarantine/${input.accountId}/`,
      )
    )
      throw new Error("partner_document_scan_binding_invalid");
    const lease = row.sourceMetadata?.["scanLeaseUntil"];
    if (typeof lease === "string" && Date.parse(lease) > Date.now())
      throw new Error("partner_document_scan_busy");
    await tx
      .update(mediaAssets)
      .set({
        sourceMetadata: {
          ...row.sourceMetadata,
          scanClaim: claim,
          scanLeaseUntil: new Date(Date.now() + 120_000).toISOString(),
        },
      })
      .where(eq(mediaAssets.id, row.id));
    return row;
  });
  if (!asset) return;
  try {
    const bytes = await getMediaObject(
      asset.originalObjectKey,
      MAX_PARTNER_PDF_BYTES,
    );
    if (
      !hasPartnerPdfSignature(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256
    )
      throw new Error("partner_document_integrity_failed");
    const result = await scanPartnerPdfBytes(bytes);
    const objectKey = `partner/documents/${input.accountId}/${asset.id}/${asset.sha256}.pdf`;
    if (result === "clean")
      await putImmutableMediaObject({
        key: objectKey,
        body: bytes,
        contentType: "application/pdf",
      });
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, asset.id),
            eq(mediaAssets.partnerAccountId, input.accountId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !current ||
        current.deletedAt ||
        current.sourceMetadata?.["scanClaim"] !== claim
      )
        throw new Error("partner_document_scan_claim_lost");
      const now = new Date();
      await tx
        .update(mediaAssets)
        .set({
          status: result === "clean" ? "ready" : "failed",
          readyAt: result === "clean" ? now : null,
          ...(result === "clean"
            ? { originalObjectKey: objectKey, stagingExpiresAt: null }
            : {}),
          processingError:
            result === "infected" ? "document_scan_rejected" : null,
          sourceMetadata: {
            ...current.sourceMetadata,
            scanStatus: result,
            scannedAt: now.toISOString(),
            scanClaim: null,
            scanLeaseUntil: null,
            replacementRequired: result === "infected",
          },
        })
        .where(eq(mediaAssets.id, asset.id));
      await tx
        .insert(auditLogs)
        .values({
          actorType: "system",
          actorLabel: "partner-document-scanner",
          action: "partner.document.scanned",
          entityType: "media_asset",
          entityId: asset.id,
          meta: {
            partnerAccountId: input.accountId,
            outcome: result,
            sha256: asset.sha256,
          },
        });
      if (result === "clean") {
        const jobs = await tx
          .select({ id: partnerJobEvidence.partnerBookingId })
          .from(partnerJobEvidence)
          .where(
            and(
              eq(partnerJobEvidence.mediaAssetId, asset.id),
              eq(partnerJobEvidence.partnerAccountId, input.accountId),
              isNull(partnerJobEvidence.deletedAt),
            ),
          );
        for (const job of jobs)
          await tx
            .insert(outboxEvents)
            .values({
              type: "partner.proof.prepare",
              payload: { accountId: input.accountId, jobId: job.id },
            });
      }
    });
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        sourceMetadata: sql`(${mediaAssets.sourceMetadata} - 'scanClaim' - 'scanLeaseUntil')`,
        processingError: "document_scan_pending_retry",
      })
      .where(
        and(
          eq(mediaAssets.id, asset.id),
          sql`${mediaAssets.sourceMetadata}->>'scanClaim' = ${claim}`,
        ),
      );
    throw error;
  }
}
