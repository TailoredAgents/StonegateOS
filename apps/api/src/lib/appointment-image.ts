import { createHash } from "node:crypto";
import decodeHeic from "heic-decode";
import sharp from "sharp";

export const MAX_APPOINTMENT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_APPOINTMENT_IMAGE_PIXELS = 40_000_000;
export const MAX_APPOINTMENT_IMAGE_DIMENSION = 12_000;

export const ACCEPTED_APPOINTMENT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type AppointmentImageType =
  (typeof ACCEPTED_APPOINTMENT_IMAGE_TYPES)[number];

export type NormalizedAppointmentImage = {
  inputContentType: AppointmentImageType;
  contentType: "image/jpeg";
  width: number;
  height: number;
  inputSha256: string;
  sha256: string;
  original: Buffer;
  display: Buffer;
  thumbnail: Buffer;
};

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString("ascii");
}

function detectHeifBrand(buffer: Buffer): AppointmentImageType | null {
  if (buffer.length < 12 || ascii(buffer, 4, 4) !== "ftyp") return null;
  const brands = new Set<string>();
  brands.add(ascii(buffer, 8, 4));
  for (let offset = 16; offset + 4 <= Math.min(buffer.length, 64); offset += 4) {
    brands.add(ascii(buffer, offset, 4));
  }
  if (brands.has("avif") || brands.has("avis")) return null;
  if (
    ["heic", "heix", "hevc", "hevx"].some((brand) => brands.has(brand))
  ) {
    return "image/heic";
  }
  if (["mif1", "msf1"].some((brand) => brands.has(brand))) {
    return "image/heif";
  }
  return null;
}

export function detectAppointmentImageType(
  buffer: Buffer,
): AppointmentImageType | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    ascii(buffer, 0, 4) === "RIFF" &&
    ascii(buffer, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return detectHeifBrand(buffer);
}

function assertSafeDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_APPOINTMENT_IMAGE_DIMENSION ||
    height > MAX_APPOINTMENT_IMAGE_DIMENSION ||
    width * height > MAX_APPOINTMENT_IMAGE_PIXELS
  ) {
    throw new Error("image_dimensions_unsafe");
  }
}

export function validateDeclaredAppointmentImage(input: {
  contentType: string;
  byteLength: number;
  checksumSha256?: string | null;
}): AppointmentImageType {
  const normalizedType = input.contentType
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    !ACCEPTED_APPOINTMENT_IMAGE_TYPES.includes(
      normalizedType as AppointmentImageType,
    )
  ) {
    throw new Error("unsupported_image_type");
  }
  if (
    !Number.isInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    input.byteLength > MAX_APPOINTMENT_IMAGE_BYTES
  ) {
    throw new Error("image_size_invalid");
  }
  if (
    input.checksumSha256 &&
    !/^[a-f0-9]{64}$/i.test(input.checksumSha256)
  ) {
    throw new Error("image_checksum_invalid");
  }
  return normalizedType as AppointmentImageType;
}

export async function normalizeAppointmentImage(
  input: Buffer,
  declaredContentType?: string | null,
): Promise<NormalizedAppointmentImage> {
  if (input.byteLength <= 0) throw new Error("image_empty");
  if (input.byteLength > MAX_APPOINTMENT_IMAGE_BYTES) {
    throw new Error("image_too_large");
  }

  const detectedType = detectAppointmentImageType(input);
  if (!detectedType) throw new Error("unsupported_or_corrupt_image");
  const declared = declaredContentType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") {
    if (declared === "image/heif" || declared === "image/heic") {
      if (detectedType !== "image/heif" && detectedType !== "image/heic") {
        throw new Error("image_type_mismatch");
      }
    } else if (declared !== detectedType) {
      throw new Error("image_type_mismatch");
    }
  }

  let decodableInput = input;
  if (detectedType === "image/heic" || detectedType === "image/heif") {
    const images = await decodeHeic.all({ buffer: input });
    try {
      const image = images[0];
      if (!image) throw new Error("heif_image_missing");
      // libheif exposes authoritative dimensions before allocating the RGBA
      // display buffer. Enforce the cap before image.decode() performs that
      // allocation so forged container bytes cannot bypass the pixel limit.
      assertSafeDimensions(image.width, image.height);
      const decoded = await image.decode();
      if (
        decoded.width !== image.width ||
        decoded.height !== image.height ||
        decoded.data.byteLength !== image.width * image.height * 4
      ) {
        throw new Error("heif_decode_dimensions_mismatch");
      }
      decodableInput = await sharp(Buffer.from(decoded.data), {
        raw: {
          width: decoded.width,
          height: decoded.height,
          channels: 4,
        },
      })
        .jpeg({ quality: 94 })
        .toBuffer();
    } finally {
      images.dispose();
    }
  }

  const base = sharp(decodableInput, {
    failOn: "warning",
    limitInputPixels: MAX_APPOINTMENT_IMAGE_PIXELS,
    pages: 1,
  }).rotate();
  const metadata = await base.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("image_dimensions_missing");
  }
  const swapsOrientation =
    typeof metadata.orientation === "number" &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8;
  const width = swapsOrientation ? metadata.height : metadata.width;
  const height = swapsOrientation ? metadata.width : metadata.height;
  assertSafeDimensions(width, height);

  const original = await base
    .clone()
    .resize({
      width: 6_000,
      height: 6_000,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  const display = await base
    .clone()
    .resize({
      width: 2_048,
      height: 2_048,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const thumbnail = await base
    .clone()
    .resize({
      width: 480,
      height: 480,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 76, mozjpeg: true })
    .toBuffer();

  const finalMetadata = await sharp(original).metadata();
  if (!finalMetadata.width || !finalMetadata.height) {
    throw new Error("normalized_image_dimensions_missing");
  }

  return {
    inputContentType: detectedType,
    contentType: "image/jpeg",
    width: finalMetadata.width,
    height: finalMetadata.height,
    inputSha256: createHash("sha256").update(input).digest("hex"),
    sha256: createHash("sha256").update(original).digest("hex"),
    original,
    display,
    thumbnail,
  };
}
