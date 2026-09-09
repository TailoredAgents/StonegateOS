/** Local codec check against an explicitly supplied, non-sensitive HEIC/HEIF fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { normalizeAppointmentImage } from "../src/lib/appointment-image";

const path = process.argv[2];
if (!path || !/\.(heic|heif)$/i.test(path))
  throw new Error("Supply an explicit local HEIC/HEIF fixture path.");
const source = await readFile(path);
const result = await normalizeAppointmentImage(source, "image/heic");
for (const bytes of [result.original, result.display, result.thumbnail]) {
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.ok(metadata.width && metadata.height);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
}
console.log(
  JSON.stringify({
    status: "passed",
    inputBytes: source.length,
    inputSha256: createHash("sha256").update(source).digest("hex"),
    width: result.width,
    height: result.height,
    originalBytes: result.original.length,
    displayBytes: result.display.length,
    thumbnailBytes: result.thumbnail.length,
    externalMetadata: "absent",
  }),
);
