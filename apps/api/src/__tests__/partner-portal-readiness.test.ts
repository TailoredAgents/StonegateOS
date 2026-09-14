import { inspectPartnerPortalReadiness } from "@/lib/partner-portal-readiness";

const ready = {
  NODE_ENV: "production",
  PARTNER_PORTAL_V2_READS_ENABLED: "true",
  PARTNER_PORTAL_V2_WRITES_ENABLED: "true",
  PARTNER_PORTAL_PURPOSE_AUTH_ENABLED: "true",
  PARTNER_PORTAL_INTERNAL_TEST_MODE: "false",
  PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED: "false",
  PARTNER_LOCATION_SECRET_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
  PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
};

describe("Partner Portal release readiness", () => {
  it("detects the activation-only production outage", () => {
    const result = inspectPartnerPortalReadiness({
      NODE_ENV: "production",
      PARTNER_PORTAL_PURPOSE_AUTH_ENABLED: "true",
    });
    expect(result).toMatchObject({
      ok: false,
      reads: false,
      writes: false,
      mode: "maintenance",
    });
    expect(result.issues).toContain("PARTNER_PORTAL_V2_READS_ENABLED");
    expect(result.issues).toContain("PARTNER_PORTAL_V2_WRITES_ENABLED");
  });
  it("accepts explicit production configuration without requiring payments or automatic confirmation", () => {
    expect(inspectPartnerPortalReadiness(ready)).toEqual({
      ok: true,
      mode: "available",
      reads: true,
      writes: true,
      issues: [],
    });
  });
  it("reports maintenance and read-only modes without silently enabling writes", () => {
    expect(
      inspectPartnerPortalReadiness({
        ...ready,
        PARTNER_PORTAL_V2_READS_ENABLED: "false",
      }),
    ).toMatchObject({
      ok: false,
      mode: "maintenance",
      writes: false,
      issues: [],
    });
    expect(
      inspectPartnerPortalReadiness({
        ...ready,
        PARTNER_PORTAL_V2_WRITES_ENABLED: "false",
      }),
    ).toMatchObject({
      ok: false,
      mode: "read_only",
      reads: true,
      writes: false,
      issues: [],
    });
  });
  it("rejects internal account restrictions and broken security keys without exposing values", () => {
    const result = inspectPartnerPortalReadiness({
      ...ready,
      PARTNER_PORTAL_INTERNAL_TEST_MODE: "true",
      PARTNER_LOCATION_SECRET_KEY_BASE64: "invalid-secret",
      PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64: "another-secret",
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/invalid-secret|another-secret/);
  });
  it("validates the current version of an existing keyring", () => {
    const env = {
      ...ready,
      PARTNER_LOCATION_SECRET_KEY_VERSION: "2",
      PARTNER_LOCATION_SECRET_KEYS_JSON: JSON.stringify({
        2: ready.PARTNER_LOCATION_SECRET_KEY_BASE64,
      }),
    };
    expect(inspectPartnerPortalReadiness(env).ok).toBe(true);
    expect(
      inspectPartnerPortalReadiness({
        ...env,
        PARTNER_LOCATION_SECRET_KEY_VERSION: "3",
      }).ok,
    ).toBe(false);
  });

  it.each([
    {
      version: "2",
      keys: {
        1: "invalid-old-key",
        2: ready.PARTNER_LOCATION_SECRET_KEY_BASE64,
      },
    },
    {
      version: "2",
      keys: {
        invalid: ready.PARTNER_LOCATION_SECRET_KEY_BASE64,
        2: ready.PARTNER_LOCATION_SECRET_KEY_BASE64,
      },
    },
    {
      version: "2147483648",
      keys: { 2147483648: ready.PARTNER_LOCATION_SECRET_KEY_BASE64 },
    },
  ])(
    "rejects every unusable keyring entry and out-of-range version",
    ({ version, keys }) => {
      const result = inspectPartnerPortalReadiness({
        ...ready,
        PARTNER_LOCATION_SECRET_KEY_VERSION: version,
        PARTNER_LOCATION_SECRET_KEYS_JSON: JSON.stringify(keys),
      });
      expect(result.ok).toBe(false);
      expect(result.issues).toContain(
        "PARTNER_LOCATION_SECRET_KEY_BASE64/current keyring version",
      );
      expect(JSON.stringify(result)).not.toContain("invalid-old-key");
    },
  );

  it("uses the runtime numeric version normalization", () => {
    expect(
      inspectPartnerPortalReadiness({
        ...ready,
        PARTNER_LOCATION_SECRET_KEYS_JSON: JSON.stringify({
          "01": ready.PARTNER_LOCATION_SECRET_KEY_BASE64,
        }),
      }).ok,
    ).toBe(true);
  });
});
