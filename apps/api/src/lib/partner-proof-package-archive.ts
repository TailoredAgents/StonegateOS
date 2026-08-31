import { createHash } from "node:crypto";

export type PartnerProofArchiveEntry = Readonly<{
  path: string;
  body: Buffer;
}>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(body: Buffer): number {
  let value = 0xffffffff;
  for (const byte of body) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(at: Date): { date: number; time: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    date:
      ((year - 1980) << 9) |
      ((at.getUTCMonth() + 1) << 5) |
      at.getUTCDate(),
    time:
      (at.getUTCHours() << 11) |
      (at.getUTCMinutes() << 5) |
      Math.floor(at.getUTCSeconds() / 2),
  };
}

function checkedArchivePath(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("The proof archive contains an unsafe path.");
  }
  const encoded = Buffer.from(normalized, "utf8");
  if (encoded.byteLength > 0xffff) {
    throw new TypeError("The proof archive path is too long.");
  }
  return normalized;
}

/**
 * Builds a deterministic, uncompressed ZIP. Store mode is deliberate: the
 * image payloads are already compressed and must remain byte-for-byte equal to
 * the immutable originals whose checksums appear in the completion record.
 */
export function createPartnerProofArchive(
  entries: readonly PartnerProofArchiveEntry[],
  generatedAt: Date,
): Buffer {
  if (entries.length === 0 || entries.length > 0xffff) {
    throw new TypeError("The proof archive entry count is invalid.");
  }
  const timestamp = dosTimestamp(generatedAt);
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const path = checkedArchivePath(entry.path);
    if (seen.has(path)) throw new TypeError("The proof archive path is duplicated.");
    seen.add(path);
    if (entry.body.byteLength > 0xffffffff) {
      throw new TypeError("The proof archive entry is too large.");
    }
    const name = Buffer.from(path, "utf8");
    const checksum = crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.body.byteLength, 18);
    local.writeUInt32LE(entry.body.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.body.byteLength, 20);
    central.writeUInt32LE(entry.body.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.body.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function sha256PartnerProofBytes(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
