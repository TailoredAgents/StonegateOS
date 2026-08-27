import assert from "node:assert/strict";
import test from "node:test";
import {
  binaryUploadSha256Hex,
  readBinaryUploadFile,
  verifyBinaryUploadPayload,
} from "../src/app/mobile/lib/binary-upload";

const BYTES = Uint8Array.from([1, 2, 3, 4]).buffer;
const SHA256 =
  "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

void test("shared binary upload hashing is stable", async () => {
  assert.equal(await binaryUploadSha256Hex(BYTES), SHA256);
});

void test("shared binary upload preparation enforces bounds and complete reads", async () => {
  const file = {
    size: BYTES.byteLength,
    arrayBuffer: () => Promise.resolve(BYTES),
  } as File;
  assert.deepEqual(await readBinaryUploadFile({ file, maxBytes: 4 }), {
    bytes: BYTES,
    byteLength: 4,
    checksumSha256: SHA256,
  });
  await assert.rejects(
    readBinaryUploadFile({ file, maxBytes: 3 }),
    /binary_upload_size_invalid/u,
  );
});

void test("shared binary upload verification catches persisted corruption", async () => {
  assert.deepEqual(
    await verifyBinaryUploadPayload({
      bytes: BYTES,
      expectedByteLength: 4,
      expectedChecksumSha256: SHA256,
    }),
    BYTES,
  );
  await assert.rejects(
    verifyBinaryUploadPayload({
      bytes: BYTES,
      expectedByteLength: 4,
      expectedChecksumSha256: "0".repeat(64),
    }),
    /binary_upload_checksum_mismatch/u,
  );
});
