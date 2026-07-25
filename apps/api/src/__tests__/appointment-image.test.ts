import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  detectAppointmentImageType,
  MAX_APPOINTMENT_IMAGE_BYTES,
  normalizeAppointmentImage,
  validateDeclaredAppointmentImage,
} from "@/lib/appointment-image";

describe("appointment image policy", () => {
  it("recognizes each supported container from its bytes", () => {
    expect(
      detectAppointmentImageType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])),
    ).toBe("image/jpeg");
    expect(
      detectAppointmentImageType(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]),
      ),
    ).toBe("image/png");
    expect(
      detectAppointmentImageType(Buffer.from("RIFF0000WEBP", "ascii")),
    ).toBe("image/webp");

    const heic = Buffer.alloc(24);
    heic.writeUInt32BE(24, 0);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    expect(detectAppointmentImageType(heic)).toBe("image/heic");
  });

  it("rejects unsupported declared types, oversized inputs, and bad hashes", () => {
    expect(() =>
      validateDeclaredAppointmentImage({
        contentType: "image/svg+xml",
        byteLength: 10,
      }),
    ).toThrow("unsupported_image_type");
    expect(() =>
      validateDeclaredAppointmentImage({
        contentType: "image/jpeg",
        byteLength: MAX_APPOINTMENT_IMAGE_BYTES + 1,
      }),
    ).toThrow("image_size_invalid");
    expect(() =>
      validateDeclaredAppointmentImage({
        contentType: "image/jpeg",
        byteLength: 10,
        checksumSha256: "not-a-hash",
      }),
    ).toThrow("image_checksum_invalid");
  });

  it("normalizes orientation and removes source metadata", async () => {
    const input = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: "#4d7c0f",
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await normalizeAppointmentImage(input, "image/jpeg");
    const metadata = await sharp(result.original).metadata();

    expect(result.contentType).toBe("image/jpeg");
    expect(result.width).toBe(20);
    expect(result.height).toBe(40);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(result.thumbnail.byteLength).toBeGreaterThan(0);
    expect(result.inputSha256).toBe(
      createHash("sha256").update(input).digest("hex"),
    );
    expect(result.sha256).toBe(
      createHash("sha256").update(result.original).digest("hex"),
    );
  });

  it("rejects a declared type that does not match magic bytes", async () => {
    const input = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: "#000000",
      },
    })
      .png()
      .toBuffer();

    await expect(
      normalizeAppointmentImage(input, "image/jpeg"),
    ).rejects.toThrow("image_type_mismatch");
  });

  it("rejects GIF and arbitrary bytes", async () => {
    await expect(
      normalizeAppointmentImage(
        Buffer.from("GIF89a000000000000", "ascii"),
        "image/gif",
      ),
    ).rejects.toThrow("unsupported_or_corrupt_image");
    await expect(
      normalizeAppointmentImage(Buffer.from("not-an-image")),
    ).rejects.toThrow("unsupported_or_corrupt_image");
  });
});
