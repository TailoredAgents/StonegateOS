import {
  LEGACY_RESIDENTIAL_VALIDITY_DAYS,
  resolveLegacyQuoteSendTiming,
} from "@/lib/quote-legacy-expiry";

describe("legacy quote expiry safety during V2 rollout", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");

  it("defaults first issue to the locked 14-day residential validity", () => {
    const timing = resolveLegacyQuoteSendTiming({
      now,
      sentAt: null,
      expiresAt: null,
    });
    expect(LEGACY_RESIDENTIAL_VALIDITY_DAYS).toBe(14);
    expect(timing.firstSentAt).toEqual(now);
    expect(timing.expiresAt.toISOString()).toBe("2026-09-13T12:00:00.000Z");
  });

  it("preserves draft expiry on issue and issued expiry on resend", () => {
    const expiry = new Date("2026-09-20T12:00:00.000Z");
    expect(
      resolveLegacyQuoteSendTiming({ now, sentAt: null, expiresAt: expiry }),
    ).toMatchObject({ expiresAt: expiry });
    const sentAt = new Date("2026-08-29T12:00:00.000Z");
    expect(
      resolveLegacyQuoteSendTiming({ now, sentAt, expiresAt: expiry }),
    ).toEqual({ firstSentAt: sentAt, expiresAt: expiry });
  });

  it("requires a revision to change or revive an issued expiry", () => {
    const sentAt = new Date("2026-08-20T12:00:00.000Z");
    expect(() =>
      resolveLegacyQuoteSendTiming({
        now,
        sentAt,
        expiresAt: new Date("2026-09-20T12:00:00.000Z"),
        requestedValidityDays: 30,
      }),
    ).toThrow("requires a revision");
    expect(() =>
      resolveLegacyQuoteSendTiming({
        now,
        sentAt,
        expiresAt: new Date("2026-08-25T12:00:00.000Z"),
      }),
    ).toThrow("expired");
  });
});
