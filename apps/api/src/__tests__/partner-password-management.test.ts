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
import { verifyPartnerPassword } from "@/lib/partner-password-crypto";

describe("partner password security policy", () => {
  const now = new Date("2026-08-30T16:00:00.000Z");

  it("accepts recent password auth and never treats a magic link as privileged", () => {
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "password",
        assuranceLevel: "aal1",
        sessionCreatedAt: new Date(now.getTime() - 14 * 60_000),
        mfaVerifiedAt: null,
        now,
      }),
    ).toBe(true);
    expect(
      isRecentPartnerPasswordAuthentication({
        authMethod: "magic_link",
        assuranceLevel: "aal1",
        sessionCreatedAt: new Date(now.getTime() - 1_000),
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

  it("uses Argon2id with a 15-character policy and rejects malformed hashes", async () => {
    expect(PARTNER_PASSWORD_MIN_LENGTH).toBe(15);
    expect(PARTNER_PASSWORD_MAX_LENGTH).toBeLessThanOrEqual(128);
    const encoded = await hashPassword("a-secure-example-password");
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(await verifyPassword("a-secure-example-password", encoded)).toBe(
      true,
    );
    expect(await verifyPassword("different-password", encoded)).toBe(false);
    await expect(verifyPassword("anything", "scrypt$YQ$Yg")).resolves.toBe(
      false,
    );
  });

  it("verifies legacy scrypt credentials and marks them for rehash", async () => {
    const salt = Buffer.alloc(16, 7);
    const digest = scryptSync("legacy-partner-password", salt, 64);
    const encoded = `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
    await expect(
      verifyPartnerPassword("legacy-partner-password", encoded),
    ).resolves.toEqual({ valid: true, needsRehash: true, hashVersion: 1 });
    await expect(
      verifyPartnerPassword("wrong-partner-password", encoded),
    ).resolves.toEqual({ valid: false, needsRehash: true, hashVersion: 1 });
  });

  it("normalizes bounded US and E.164 phone input even if metadata is unavailable", () => {
    expect(normalizePhoneE164("+1 (410) 555-0199")).toBe("+14105550199");
    expect(normalizePhoneE164("410-555-0199")).toBe("+14105550199");
    expect(normalizePhoneE164("not-a-phone")).toBeNull();
  });
});
import { scryptSync } from "node:crypto";
