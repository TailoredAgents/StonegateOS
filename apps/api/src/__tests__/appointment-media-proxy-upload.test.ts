import { createHash } from "node:crypto";
import {
  AppointmentMediaError,
  validateAppointmentMediaProxyUpload,
} from "@/lib/appointment-media";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

function validate(
  overrides: Partial<
    Parameters<typeof validateAppointmentMediaProxyUpload>[0]
  > = {},
) {
  return validateAppointmentMediaProxyUpload({
    bytes: jpeg,
    declaredContentType: "image/jpeg",
    expectedByteSize: jpeg.byteLength,
    expectedContentType: "image/jpeg",
    expectedSha256: createHash("sha256").update(jpeg).digest("hex"),
    ...overrides,
  });
}

describe("appointment media same-origin proxy validation", () => {
  it("accepts bytes that exactly match the stored upload declaration", () => {
    expect(validate()).toEqual({
      contentType: "image/jpeg",
      sha256: createHash("sha256").update(jpeg).digest("hex"),
    });
  });

  it.each([
    [{ bytes: Buffer.alloc(0) }, "uploaded_image_size_invalid"],
    [{ expectedByteSize: jpeg.byteLength + 1 }, "uploaded_image_size_mismatch"],
    [{ declaredContentType: "image/png" }, "uploaded_image_type_mismatch"],
    [{ expectedSha256: "0".repeat(64) }, "image_checksum_mismatch"],
    [{ expectedSha256: null }, "media_upload_declaration_missing"],
  ] as const)("rejects invalid uploads with %s", (overrides, code) => {
    try {
      validate(overrides);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppointmentMediaError);
      expect((error as AppointmentMediaError).code).toBe(code);
    }
  });
});
