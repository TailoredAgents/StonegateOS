import type { NextRequest } from "next/server";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  mediaAssets,
  partnerDocumentAccessLogs,
  partnerDocuments,
  partnerJobEvidence,
  partnerProofPackages,
  partnerProofShareLinks,
} from "@/db";
import {
  createMediaReadUrl,
  getMediaStorageBucket,
} from "@/lib/media-storage";
import { hashPartnerProofShareToken } from "@/lib/partner-proof-share-tokens";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const { token } = await context.params;
  const tokenHash = hashPartnerProofShareToken(token);
  if (!tokenHash) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .select({
          shareId: partnerProofShareLinks.id,
          accountId: partnerProofShareLinks.partnerAccountId,
          expiresAt: partnerProofShareLinks.expiresAt,
          packageId: partnerProofPackages.id,
          jobId: partnerProofPackages.partnerBookingId,
          packageVersion: partnerProofPackages.version,
          manifest: partnerProofPackages.manifest,
          manifestSha256: partnerProofPackages.manifestSha256,
          pdfDocumentId: partnerProofPackages.pdfDocumentId,
          zipDocumentId: partnerProofPackages.zipDocumentId,
          generatedAt: partnerProofPackages.generatedAt,
        })
        .from(partnerProofShareLinks)
        .innerJoin(
          partnerProofPackages,
          eq(
            partnerProofShareLinks.proofPackageId,
            partnerProofPackages.id,
          ),
        )
        .where(
          and(
            eq(partnerProofShareLinks.tokenHash, tokenHash),
            isNull(partnerProofShareLinks.revokedAt),
            gt(partnerProofShareLinks.expiresAt, now),
            eq(
              partnerProofPackages.partnerAccountId,
              partnerProofShareLinks.partnerAccountId,
            ),
          ),
        )
        .for("update", { of: partnerProofShareLinks })
        .limit(1);
      if (!row) return null;
      await tx
        .update(partnerProofShareLinks)
        .set({
          lastAccessedAt: now,
          accessCount: sql`${partnerProofShareLinks.accessCount} + 1`,
        })
        .where(eq(partnerProofShareLinks.id, row.shareId));
      await tx.insert(auditLogs).values({
        actorType: "system",
        authMethod: "service",
        correlationId,
        surface: "partner_proof_share",
        action: "partner.proof_share.accessed",
        entityType: "partner_proof_share_link",
        entityId: row.shareId,
        meta: {
          partnerAccountId: row.accountId,
          partnerBookingId: row.jobId,
          proofPackageId: row.packageId,
        },
      });
      return row;
    });
    if (!result) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const manifest = record(result.manifest);
    const proof = record(manifest?.["proof"]);
    const evidenceManifest = Array.isArray(proof?.["evidence"])
      ? proof["evidence"]
          .map(record)
          .filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const evidenceIds = evidenceManifest
      .map((item) => string(item["reference"]) ?? string(item["id"]))
      .filter((id): id is string => Boolean(id));
    const evidenceRows = evidenceIds.length
      ? await db
          .select({
            id: partnerJobEvidence.id,
            category: partnerJobEvidence.category,
            caption: partnerJobEvidence.caption,
            createdAt: partnerJobEvidence.createdAt,
            contentType: mediaAssets.contentType,
            byteSize: mediaAssets.byteSize,
            width: mediaAssets.width,
            height: mediaAssets.height,
            sha256: mediaAssets.sha256,
            originalObjectKey: mediaAssets.originalObjectKey,
            displayObjectKey: mediaAssets.displayObjectKey,
            thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
          })
          .from(partnerJobEvidence)
          .innerJoin(
            mediaAssets,
            eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
          )
          .where(
            and(
              eq(partnerJobEvidence.partnerAccountId, result.accountId),
              eq(partnerJobEvidence.partnerBookingId, result.jobId),
              inArray(partnerJobEvidence.id, evidenceIds),
              isNull(partnerJobEvidence.deletedAt),
              isNull(mediaAssets.deletedAt),
              eq(mediaAssets.status, "ready"),
            ),
          )
      : [];
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
    const evidence = await Promise.all(
      evidenceManifest.flatMap((manifestItem) => {
        const id =
          string(manifestItem["reference"]) ?? string(manifestItem["id"]);
        const row = id ? evidenceById.get(id) : null;
        if (!row) return [];
        return [
          (async () => ({
            category: row.category,
            caption: row.caption,
            capturedAt: row.createdAt.toISOString(),
            contentType: row.contentType,
            byteSize: row.byteSize,
            width: row.width,
            height: row.height,
            sha256: row.sha256,
            media: {
              thumbnailUrl: row.thumbnailObjectKey
                ? await createMediaReadUrl(row.thumbnailObjectKey, 300)
                : null,
              displayUrl: row.displayObjectKey
                ? await createMediaReadUrl(row.displayObjectKey, 300)
                : null,
              originalUrl: await createMediaReadUrl(
                row.originalObjectKey,
                300,
              ),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }))(),
        ];
      }),
    );
    const job = record(manifest?.["job"]);
    const location = record(job?.["location"]);
    const safeJob = {
      status: string(job?.["status"]),
      service: record(job?.["service"]),
      location: {
        name: string(location?.["name"]),
        city: string(location?.["city"]),
        state: string(location?.["state"]),
      },
      promisedArrivalWindow: record(job?.["promisedArrivalWindow"]),
      completedAt: string(job?.["completedAt"]),
    };
    const requestedDocumentIds = [
      result.pdfDocumentId,
      result.zipDocumentId,
    ].filter((id): id is string => Boolean(id));
    const documentRows = requestedDocumentIds.length
      ? await db
          .select({
            id: partnerDocuments.id,
            filename: partnerDocuments.filename,
            contentType: partnerDocuments.contentType,
            byteSize: partnerDocuments.byteSize,
            storageBucket: partnerDocuments.storageBucket,
            storageObjectKey: partnerDocuments.storageObjectKey,
            sha256: partnerDocuments.sha256,
          })
          .from(partnerDocuments)
          .where(
            and(
              eq(partnerDocuments.partnerAccountId, result.accountId),
              eq(partnerDocuments.partnerBookingId, result.jobId),
              inArray(partnerDocuments.id, requestedDocumentIds),
            ),
          )
      : [];
    const documentsById = new Map(documentRows.map((row) => [row.id, row]));
    const configuredBucket = getMediaStorageBucket();
    const createDownload = async (documentId: string | null) => {
      if (!documentId) return null;
      const document = documentsById.get(documentId);
      if (!document || document.storageBucket !== configuredBucket) return null;
      return {
        url: await createMediaReadUrl(document.storageObjectKey, 300),
        filename: document.filename,
        contentType: document.contentType,
        byteSize: document.byteSize,
        checksumSha256: document.sha256,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    };
    const [pdfDownload, zipDownload] = await Promise.all([
      createDownload(result.pdfDocumentId),
      createDownload(result.zipDocumentId),
    ]);
    const accessibleDocumentIds = [
      pdfDownload ? result.pdfDocumentId : null,
      zipDownload ? result.zipDocumentId : null,
    ].filter((id): id is string => Boolean(id));
    if (accessibleDocumentIds.length) {
      await db.insert(partnerDocumentAccessLogs).values(
        accessibleDocumentIds.map((documentId) => ({
          partnerAccountId: result.accountId,
          partnerDocumentId: documentId,
          actorType: "share_link" as const,
          shareLinkId: result.shareId,
          action: "download_intent",
          correlationId,
        })),
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        proofPackage: {
          version: result.packageVersion,
          checksumSha256: result.manifestSha256,
          generatedAt: result.generatedAt.toISOString(),
          expiresAt: result.expiresAt.toISOString(),
          job: safeJob,
          requirements: Array.isArray(proof?.["requirements"])
            ? proof["requirements"]
            : [],
          evidence,
          downloads: {
            pdf: pdfDownload,
            originalMediaZip: zipDownload,
          },
        },
      },
      correlationId,
      200,
      {
        "Cache-Control": "private, no-store, max-age=0",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] proof share read failed", {
      correlationId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
