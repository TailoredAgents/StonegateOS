function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Shared browser-side binary hashing for appointment media and receipts. */
export async function binaryUploadSha256Hex(
  bytes: ArrayBuffer,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function readBinaryUploadFile(input: {
  file: File;
  maxBytes: number;
}): Promise<{
  bytes: ArrayBuffer;
  byteLength: number;
  checksumSha256: string;
}> {
  if (
    !Number.isSafeInteger(input.file.size) ||
    input.file.size < 1 ||
    input.file.size > input.maxBytes
  ) {
    throw new Error("binary_upload_size_invalid");
  }
  const bytes = await input.file.arrayBuffer();
  if (bytes.byteLength !== input.file.size) {
    throw new Error("binary_upload_read_incomplete");
  }
  return {
    bytes,
    byteLength: bytes.byteLength,
    checksumSha256: await binaryUploadSha256Hex(bytes),
  };
}

export async function verifyBinaryUploadPayload(input: {
  bytes: ArrayBuffer | undefined;
  expectedByteLength: number;
  expectedChecksumSha256: string;
}): Promise<ArrayBuffer> {
  if (
    !(input.bytes instanceof ArrayBuffer) ||
    !Number.isSafeInteger(input.expectedByteLength) ||
    input.expectedByteLength < 1 ||
    input.bytes.byteLength !== input.expectedByteLength
  ) {
    throw new Error("binary_upload_bytes_invalid");
  }
  const bytes = input.bytes.slice(0);
  if (
    (await binaryUploadSha256Hex(bytes)) !==
    input.expectedChecksumSha256.toLowerCase()
  ) {
    throw new Error("binary_upload_checksum_mismatch");
  }
  return bytes;
}
