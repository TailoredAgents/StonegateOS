import { AppointmentMediaUploadIntentBodySchema } from "../../app/api/appointments/[id]/media/upload-intents/route";

describe("appointment media upload-intent admission", () => {
  const validFile = {
    clientId: "dcfb511d-95f6-42c1-9505-eaa8128cc2b2",
    filename: "quoted-work.jpg",
    contentType: "image/jpeg",
    byteLength: 42,
    checksumSha256: "a".repeat(64),
  };

  it("accepts the null caption persisted by the mobile offline queue", () => {
    expect(
      AppointmentMediaUploadIntentBodySchema.safeParse({
        uploadMode: "direct_mobile",
        files: [{ ...validFile, caption: null }],
      }).success,
    ).toBe(true);
  });

  it("continues to reject invalid non-string captions", () => {
    expect(
      AppointmentMediaUploadIntentBodySchema.safeParse({
        uploadMode: "direct_mobile",
        files: [{ ...validFile, caption: 42 }],
      }).success,
    ).toBe(false);
  });
});
