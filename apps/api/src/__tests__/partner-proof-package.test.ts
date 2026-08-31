import { createHash } from "node:crypto";
import { createPartnerProofArchive } from "@/lib/partner-proof-package-archive";
import { renderPartnerProofPackageArtifacts } from "@/lib/partner-proof-package-renderer";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= zip.byteLength && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, zip.subarray(bodyStart, bodyStart + compressedSize));
    offset = bodyStart + compressedSize;
  }
  return entries;
}

describe("partner proof-package artifacts", () => {
  it("creates a standards-shaped UTF-8 ZIP without permitting path traversal", () => {
    const archive = createPartnerProofArchive(
      [{ path: "proof/café.png", body: PNG }],
      new Date("2026-08-30T12:00:00.000Z"),
    );
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(Buffer.from("proof/café.png", "utf8"))).toBe(true);
    expect(archive.readUInt32LE(archive.byteLength - 22)).toBe(0x06054b50);
    expect(zipEntries(archive).get("proof/café.png")).toEqual(PNG);
    expect(() =>
      createPartnerProofArchive(
        [{ path: "../private.png", body: PNG }],
        new Date("2026-08-30T12:00:00.000Z"),
      ),
    ).toThrow("unsafe path");
  });

  it("renders an immutable PDF and exact-original ZIP without exposing record IDs", async () => {
    const evidenceReference = "33333333-3333-4333-8333-333333333333";
    const artifacts = await renderPartnerProofPackageArtifacts({
      version: 2,
      generatedAt: "2026-08-30T12:00:00.000Z",
      manifestChecksumSha256: "a".repeat(64),
      job: {
        status: "completed",
        serviceKey: "commercial-cleanout",
        tierKey: "standard",
        projectReference: "PO-42 West Wing",
        locationName: "North Campus",
        city: "Atlanta",
        state: "GA",
        promisedArrivalStartAt: "2026-08-29T13:00:00.000Z",
        promisedArrivalEndAt: "2026-08-29T15:00:00.000Z",
        timezone: "America/New_York",
        completedAt: "2026-08-29T16:30:00.000Z",
      },
      requirements: [
        {
          category: "after",
          required: true,
          minimumCount: 1,
          readyCount: 1,
          satisfied: true,
        },
      ],
      evidence: [
        {
          reference: evidenceReference,
          category: "after",
          caption: "Area clear and swept",
          sortOrder: 0,
          contentType: "image/png",
          filename: "../after photo.png",
          byteSize: PNG.byteLength,
          width: 1,
          height: 1,
          sha256: createHash("sha256").update(PNG).digest("hex"),
          capturedAt: "2026-08-29T16:20:00.000Z",
          originalBytes: PNG,
        },
      ],
    });

    expect(artifacts.pdf.body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(artifacts.pdf.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifacts.zip.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const entries = zipEntries(artifacts.zip.body);
    const photoEntry = [...entries.entries()].find(([name]) => name.startsWith("proof/"));
    expect(photoEntry?.[1]).toEqual(PNG);
    const completionRecord = entries.get("completion-record.json")?.toString("utf8") ?? "";
    expect(completionRecord).toContain("PO-42 West Wing");
    expect(completionRecord).toContain("manifestChecksumSha256");
    expect(completionRecord).not.toContain(evidenceReference);
    expect(JSON.stringify(artifacts.publicRecord)).not.toContain(evidenceReference);
  });

  it("refuses to package originals that do not match persisted evidence", async () => {
    await expect(
      renderPartnerProofPackageArtifacts({
        version: 1,
        generatedAt: "2026-08-30T12:00:00.000Z",
        manifestChecksumSha256: "b".repeat(64),
        job: {
          status: "completed",
          serviceKey: null,
          tierKey: null,
          projectReference: null,
          locationName: null,
          city: null,
          state: null,
          promisedArrivalStartAt: null,
          promisedArrivalEndAt: null,
          timezone: "America/New_York",
          completedAt: "2026-08-29T16:30:00.000Z",
        },
        requirements: [{ category: "after", required: true, minimumCount: 1, readyCount: 1, satisfied: true }],
        evidence: [{
          reference: "reference",
          category: "after",
          caption: null,
          sortOrder: 0,
          contentType: "image/png",
          filename: "after.png",
          byteSize: PNG.byteLength,
          width: 1,
          height: 1,
          sha256: "0".repeat(64),
          capturedAt: "2026-08-29T16:20:00.000Z",
          originalBytes: PNG,
        }],
      }),
    ).rejects.toThrow("does not match");
  });
});
