import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDbForTests, getDb, mediaAssets, partnerAccounts } from "@/db";
import {
  processPartnerDocumentScan,
  scanPartnerPdfBytes,
} from "@/lib/partner-document-scan";
import {
  getMediaObject,
  putImmutableMediaFile,
  putImmutableMediaObject,
  resetMediaStorageForTests,
} from "@/lib/media-storage";
import { writePartnerProofArchive } from "@/lib/partner-proof-package-archive";

const enabled = process.env["PARTNER_LOCAL_MEDIA_TESTS"] === "1";
if (enabled) {
  for (const name of ["DATABASE_URL", "MEDIA_OBJECT_ENDPOINT"]) {
    const url = new URL(process.env[name] ?? "invalid:");
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error(`Local media tests require a local ${name}.`);
    if (
      name === "DATABASE_URL" &&
      (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !/^portal_[a-z0-9_]*(?:test|rehearsal|restore|remediation|browser|final)[a-z0-9_]*$/.test(
          decodeURIComponent(url.pathname.slice(1)),
        ))
    ) {
      throw new Error(
        "Local media tests require a disposable portal test database.",
      );
    }
  }
  if (
    process.env["R2_ACCOUNT_ID"] ||
    process.env["PARTNER_CLAMAV_HOST"] !== "127.0.0.1" ||
    process.env["PARTNER_CLAMAV_SOCKET"]
  ) {
    throw new Error(
      "Local media tests cannot use external storage or scanners.",
    );
  }
}

(enabled ? describe : describe.skip)(
  "actual local ClamAV and S3-compatible storage (not production R2 certification)",
  () => {
    afterAll(async () => {
      resetMediaStorageForTests();
      await closeDbForTests();
    });
    it("accepts a clean PDF and detects the harmless EICAR antivirus test signature", async () => {
      const clean = Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
      );
      // Standard harmless antivirus test marker, not executable malware.
      const marker =
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}" +
        "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
      const testPdf = Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Length ${marker.length} >>\nstream\n${marker}\nendstream\nendobj\n%%EOF\n`,
      );
      await expect(scanPartnerPdfBytes(clean)).resolves.toBe("clean");
      await expect(scanPartnerPdfBytes(testPdf)).resolves.toBe("infected");
    }, 60_000);

    it("uploads and rereads an immutable streamed ZIP; replay succeeds and conflicting bytes cannot overwrite it", async () => {
      const directory = await mkdtemp(join(tmpdir(), "stonegate-media-local-"));
      const path = join(directory, "originals.zip");
      const key = `local-proof-test/${randomUUID()}/originals.zip`;
      const body = Buffer.alloc(1024 * 1024, 37);
      try {
        const archive = await writePartnerProofArchive(
          (async function* () {
            for (let i = 0; i < 3; i += 1)
              yield await Promise.resolve({ path: `proof/${i}.bin`, body });
          })(),
          new Date("2026-09-09T12:00:00Z"),
          path,
        );
        const input = { key, path, ...archive, contentType: "application/zip" };
        await expect(putImmutableMediaFile(input)).resolves.toBe("created");
        await expect(putImmutableMediaFile(input)).resolves.toBe(
          "already_exists",
        );
        await expect(
          putImmutableMediaObject({
            key,
            body: Buffer.from("different"),
            contentType: "application/zip",
          }),
        ).rejects.toThrow("media_immutable_object_conflict");
        const stored = await getMediaObject(key, archive.byteSize);
        expect(stored).toEqual(await readFile(path));
        expect(createHash("sha256").update(stored).digest("hex")).toBe(
          archive.sha256,
        );
        await expect(getMediaObject(key, 1024)).rejects.toThrow(
          "media_object_too_large",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);

    it("moves a real quarantined PDF to ready only after the scanner passes and preserves account isolation on replay", async () => {
      const accountId = randomUUID(),
        assetId = randomUUID();
      const body = Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
      );
      const key = `partner/quarantine/${accountId}/${assetId}.pdf`;
      const db = getDb();
      await db.insert(partnerAccounts).values({
        id: accountId,
        name: "Local scan validation",
        normalizedName: accountId,
      });
      await putImmutableMediaObject({
        key,
        body,
        contentType: "application/pdf",
      });
      await db.insert(mediaAssets).values({
        id: assetId,
        partnerAccountId: accountId,
        status: "processing",
        contentType: "application/pdf",
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        storageBucket: process.env["MEDIA_OBJECT_BUCKET"]!,
        originalObjectKey: key,
        sourceMetadata: { scanStatus: "queued" },
      });
      await processPartnerDocumentScan({ accountId: randomUUID(), assetId });
      const [before] = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, assetId));
      expect(before?.status).toBe("processing");
      expect(before?.originalObjectKey).toBe(key);
      await processPartnerDocumentScan({ accountId, assetId });
      await processPartnerDocumentScan({ accountId, assetId });
      const [after] = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, assetId));
      expect(after?.status).toBe("ready");
      expect(after?.sourceMetadata?.["scanStatus"]).toBe("clean");
      expect(after?.originalObjectKey).toMatch(
        new RegExp(`^partner/documents/${accountId}/`),
      );
      expect(
        await getMediaObject(after!.originalObjectKey, body.length),
      ).toEqual(body);
    }, 60_000);
  },
);
