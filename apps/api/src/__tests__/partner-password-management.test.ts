import {
  isRecentPartnerPasswordAuthentication,
  PARTNER_PASSWORD_MAX_LENGTH,
  PARTNER_PASSWORD_MIN_LENGTH,
} from "@/lib/partner-password-management";
import {
  hashPassword,
  normalizePhoneE164,
  verifyPassword,
} from "@/lib/partner-portal-auth";

describe("partner password security policy", () => {
  const now = new Date("2026-08-30T16:00:00.000Z");

  it("accepts only a recently created magic-link session", () => {
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "magic_link",
        assuranceLevel: "aal1",
        sessionCreatedAt: new Date(now.getTime() - 29 * 60_000),
        mfaVerifiedAt: null,
        now,
      }),
    ).toBe(true);
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "magic_link",
        assuranceLevel: "aal1",
        sessionCreatedAt: new Date(now.getTime() - 31 * 60_000),
        mfaVerifiedAt: null,
        now,
      }),
    ).toBe(false);
  });

  it("accepts only a recent AAL2 verification", () => {
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "mfa_step_up",
        assuranceLevel: "aal2",
        sessionCreatedAt: new Date(now.getTime() - 60 * 60_000),
        mfaVerifiedAt: new Date(now.getTime() - 14 * 60_000),
        now,
      }),
    ).toBe(true);
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "mfa_step_up",
        assuranceLevel: "aal2",
        sessionCreatedAt: new Date(now.getTime() - 60 * 60_000),
        mfaVerifiedAt: new Date(now.getTime() - 16 * 60_000),
        now,
      }),
    ).toBe(false);
  });

  it("uses a bounded password policy and safely rejects malformed hashes", () => {
    expect(PARTNER_PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
    expect(PARTNER_PASSWORD_MAX_LENGTH).toBeLessThanOrEqual(128);
    const encoded = hashPassword("a-secure-example-password");
    expect(verifyPassword("a-secure-example-password", encoded)).toBe(true);
    expect(verifyPassword("different-password", encoded)).toBe(false);
    expect(() => verifyPassword("anything", "scrypt$YQ$Yg")).not.toThrow();
    expect(verifyPassword("anything", "scrypt$YQ$Yg")).toBe(false);
  });

  it("normalizes bounded US and E.164 phone input even if metadata is unavailable", () => {
    expect(normalizePhoneE164("+1 (410) 555-0199")).toBe("+14105550199");
    expect(normalizePhoneE164("410-555-0199")).toBe("+14105550199");
    expect(normalizePhoneE164("not-a-phone")).toBeNull();
  });
});
