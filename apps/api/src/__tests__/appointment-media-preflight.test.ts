import {
  classifyAppointmentMediaPreflightError,
  preflightAppointmentMediaCandidates,
} from "@/lib/appointment-media-preflight";

describe("appointment media migration preflight", () => {
  it("fetches and fully validates remote candidates without storage writes", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const fetchRemote = jest.fn(() =>
      Promise.resolve({
        bytes,
        contentType: "image/jpeg",
      }),
    );
    const normalize = jest.fn(() =>
      Promise.resolve({
        inputContentType: "image/jpeg" as const,
        contentType: "image/jpeg" as const,
        width: 10,
        height: 10,
        inputSha256: "a".repeat(64),
        sha256: "b".repeat(64),
        original: bytes,
        display: bytes,
        thumbnail: bytes,
      }),
    );

    await expect(
      preflightAppointmentMediaCandidates(
        [
          {
            source: "conversation_message",
            id: "message-1:0",
            input: {
              kind: "remote",
              url: "https://api.twilio.com/media/1",
              provider: "twilio",
            },
          },
        ],
        { dependencies: { fetchRemote, normalize } },
      ),
    ).resolves.toEqual({ checked: 1, passed: 1, failed: [] });
    expect(fetchRemote).toHaveBeenCalledWith({
      url: "https://api.twilio.com/media/1",
      provider: "twilio",
    });
    expect(normalize).toHaveBeenCalledWith(bytes, "image/jpeg");
  });

  it("reports every failure by stable source ID and category", async () => {
    const fetchRemote = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_media_fetch_timeout"))
      .mockResolvedValueOnce({
        bytes: Buffer.from("not-an-image"),
        contentType: "image/jpeg",
      });
    const normalize = jest
      .fn()
      .mockRejectedValueOnce(new Error("unsupported_or_corrupt_image"));

    const report = await preflightAppointmentMediaCandidates(
      [
        {
          source: "instant_quote",
          id: "quote-1:0",
          input: { kind: "remote", url: "https://example.com/missing.jpg" },
        },
        {
          source: "appointment_attachment",
          id: "attachment-1",
          input: { kind: "remote", url: "https://example.com/bad.jpg" },
        },
      ],
      {
        concurrency: 1,
        dependencies: { fetchRemote, normalize },
      },
    );

    expect(report).toEqual({
      checked: 2,
      passed: 0,
      failed: [
        {
          source: "instant_quote",
          id: "quote-1:0",
          category: "unavailable",
          error: "remote_media_fetch_timeout",
        },
        {
          source: "appointment_attachment",
          id: "attachment-1",
          category: "unsupported",
          error: "unsupported_or_corrupt_image",
        },
      ],
    });
  });

  it.each([
    ["remote_media_too_large", "oversized"],
    ["image_dimensions_unsafe", "unsafe_dimensions"],
    ["remote_media_host_forbidden", "rejected"],
    ["invalid JPEG data", "corrupt"],
  ] as const)("classifies %s as %s", (message, category) => {
    expect(classifyAppointmentMediaPreflightError(new Error(message))).toBe(
      category,
    );
  });
});
