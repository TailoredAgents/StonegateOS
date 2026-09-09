/** Local filesystem-only maximum-size package check. Never reads a DB or a provider. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPartnerProofPackageToFile } from "../src/lib/partner-proof-package-renderer";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const byteSize = 10 * 1024 * 1024;
// Valid image bytes plus trailing padding exercise the allowed byte limit without a decompression bomb.
function original() {
  const bytes = Buffer.alloc(byteSize);
  png.copy(bytes);
  return bytes;
}
const sha256 = createHash("sha256").update(original()).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "stonegate-proof-memory-"));
let inFlight = 0,
  maximumInFlight = 0,
  originalsRead = 0;
try {
  const result = await renderPartnerProofPackageToFile(
    {
      version: 1,
      generatedAt: "2026-09-09T12:00:00Z",
      manifestChecksumSha256: "a".repeat(64),
      job: {
        status: "completed",
        serviceKey: "service_request",
        tierKey: null,
        projectReference: null,
        locationName: "Local test location",
        city: "Atlanta",
        state: "GA",
        timezone: "America/New_York",
        completedAt: "2026-09-09T12:00:00Z",
        promisedArrivalStartAt: null,
        promisedArrivalEndAt: null,
      },
      requirements: [
        {
          category: "before",
          required: true,
          minimumCount: 20,
          readyCount: 20,
          satisfied: true,
        },
        {
          category: "after",
          required: true,
          minimumCount: 20,
          readyCount: 20,
          satisfied: true,
        },
      ],
      evidence: Array.from({ length: 40 }, (_, i) => ({
        reference: `test-${i}`,
        category: i < 20 ? "before" : "after",
        caption: null,
        sortOrder: i,
        contentType: "image/png",
        filename: `${i}.png`,
        byteSize,
        sha256,
        width: 1,
        height: 1,
        capturedAt: "2026-09-09T12:00:00Z",
      })),
    },
    join(directory, "originals.zip"),
    () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      const bytes = original();
      originalsRead += 1;
      inFlight -= 1;
      return Promise.resolve(bytes);
    },
  );
  assert.equal(originalsRead, 40);
  assert.equal(maximumInFlight, 1);
  assert.equal(result.pdf.body.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await stat(result.zip.path)).size, result.zip.byteSize);
  assert.ok(result.zip.byteSize > 400 * 1024 * 1024);
  const zip = await open(result.zip.path, "r");
  try {
    const footer = Buffer.alloc(22);
    await zip.read(footer, 0, 22, result.zip.byteSize - 22);
    assert.equal(footer.readUInt32LE(0), 0x06054b50);
    assert.equal(footer.readUInt16LE(8), 41);
  } finally {
    await zip.close();
  }
  console.log(
    JSON.stringify({
      originalsRead,
      maximumInFlight,
      zipBytes: result.zip.byteSize,
      pdfBytes: result.pdf.body.length,
      peakRssKiB: process.resourceUsage().maxRSS,
      status: "passed",
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
