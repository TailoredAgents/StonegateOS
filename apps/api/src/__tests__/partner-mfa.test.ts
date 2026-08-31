import {
  PartnerMfaConfigurationError,
  createPartnerTotpUri,
  decryptPartnerTotpSecret,
  encryptPartnerTotpSecret,
  generatePartnerMfaRecoveryCodes,
  hashPartnerMfaRecoveryCode,
  partnerTotpCodeAt,
  verifyPartnerMfaRecoveryCode,
  verifyPartnerTotp,
} from "@/lib/partner-mfa";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const METHOD_ID = "22222222-2222-4222-8222-222222222222";
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("partner TOTP and recovery security", () => {
  const previous = {
    key: process.env["PARTNER_MFA_SECRET_KEY_BASE64"],
    keys: process.env["PARTNER_MFA_SECRET_KEYS_JSON"],
    version: process.env["PARTNER_MFA_SECRET_KEY_VERSION"],
  };

  beforeEach(() => {
    delete process.env["PARTNER_MFA_SECRET_KEYS_JSON"];
    process.env["PARTNER_MFA_SECRET_KEY_BASE64"] = Buffer.alloc(32, 9).toString(
      "base64",
    );
    process.env["PARTNER_MFA_SECRET_KEY_VERSION"] = "7";
  });

  afterAll(() => {
    if (previous.key === undefined)
      delete process.env["PARTNER_MFA_SECRET_KEY_BASE64"];
    else process.env["PARTNER_MFA_SECRET_KEY_BASE64"] = previous.key;
    if (previous.keys === undefined)
      delete process.env["PARTNER_MFA_SECRET_KEYS_JSON"];
    else process.env["PARTNER_MFA_SECRET_KEYS_JSON"] = previous.keys;
    if (previous.version === undefined)
      delete process.env["PARTNER_MFA_SECRET_KEY_VERSION"];
    else process.env["PARTNER_MFA_SECRET_KEY_VERSION"] = previous.version;
  });

  it("matches the RFC 6238 SHA-1 vector at six digits", () => {
    const at = new Date(59_000);
    expect(partnerTotpCodeAt(RFC_SECRET, at)).toBe("287082");
    expect(verifyPartnerTotp({ secret: RFC_SECRET, code: "287082", at })).toBe(
      1,
    );
  });

  it("accepts a bounded clock window and rejects a replayed counter", () => {
    const at = new Date("2026-08-30T12:00:00.000Z");
    const prior = new Date(at.getTime() - 30_000);
    const code = partnerTotpCodeAt(RFC_SECRET, prior);
    const counter = verifyPartnerTotp({ secret: RFC_SECRET, code, at });
    expect(counter).not.toBeNull();
    expect(
      verifyPartnerTotp({
        secret: RFC_SECRET,
        code,
        at,
        lastAcceptedCounter: counter,
      }),
    ).toBeNull();
    expect(
      verifyPartnerTotp({ secret: RFC_SECRET, code, at, window: 0 }),
    ).toBeNull();
  });

  it("builds a standards-compatible authenticator URI", () => {
    const uri = createPartnerTotpUri({
      email: "Admin@Example.com",
      secret: RFC_SECRET,
    });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("issuer=Stonegate+Partner+Portal");
  });

  it("encrypts the secret with user-bound authenticated encryption", () => {
    const encrypted = encryptPartnerTotpSecret({
      partnerUserId: USER_ID,
      secret: RFC_SECRET,
    });
    expect(encrypted.keyVersion).toBe(7);
    expect(encrypted.ciphertext).not.toContain(RFC_SECRET);
    expect(
      decryptPartnerTotpSecret({
        partnerUserId: USER_ID,
        ...encrypted,
      }),
    ).toBe(RFC_SECRET);
    expect(() =>
      decryptPartnerTotpSecret({
        partnerUserId: "33333333-3333-4333-8333-333333333333",
        ...encrypted,
      }),
    ).toThrow();
  });

  it("creates unique high-entropy single-display recovery codes", () => {
    const codes = generatePartnerMfaRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(
      codes.every((code) => /^(?:[A-Z2-7]{4}-){3}[A-Z2-7]{4}$/u.test(code)),
    ).toBe(true);
  });

  it("stores only keyed recovery-code hashes and verifies exact ownership", () => {
    const code = "ABCD-EFGH-JKLM-NPQR";
    const digest = hashPartnerMfaRecoveryCode({
      code,
      partnerUserId: USER_ID,
      methodId: METHOD_ID,
    });
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest.hash).not.toContain("ABCD");
    expect(
      verifyPartnerMfaRecoveryCode({
        code: "abcdefghijklmnopqr".slice(0, 16),
        expectedHash: digest.hash,
        partnerUserId: USER_ID,
        methodId: METHOD_ID,
        keyVersion: digest.keyVersion,
      }),
    ).toBe(false);
    expect(
      verifyPartnerMfaRecoveryCode({
        code,
        expectedHash: digest.hash,
        partnerUserId: USER_ID,
        methodId: METHOD_ID,
        keyVersion: digest.keyVersion,
      }),
    ).toBe(true);
  });

  it("fails closed when no encryption key is configured", () => {
    delete process.env["PARTNER_MFA_SECRET_KEY_BASE64"];
    delete process.env["PARTNER_MFA_SECRET_KEYS_JSON"];
    expect(() =>
      encryptPartnerTotpSecret({ partnerUserId: USER_ID, secret: RFC_SECRET }),
    ).toThrow(PartnerMfaConfigurationError);
  });
});
