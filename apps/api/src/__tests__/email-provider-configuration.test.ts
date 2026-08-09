import {
  classifyEmailProviderError,
  getEmailProviderConfiguration,
  isLoopbackEmailHostname,
  sanitizeEmailProviderMessageId,
} from "@/lib/email-provider";
import { inspectEmailProviderConfiguration } from "@/lib/provider-configuration";

const productionConfiguration = {
  NODE_ENV: "production",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "stonegate",
  SMTP_PASS: "private-password",
  SMTP_FROM: "Stonegate <ops@example.test>",
};

describe("email provider configuration", () => {
  it("treats a fully blank optional provider as unconfigured", () => {
    expect(getEmailProviderConfiguration({})).toBeNull();
    expect(inspectEmailProviderConfiguration({})).toEqual({
      configured: false,
      missing: ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM"],
      invalid: [],
    });
  });

  it("requires TLS for ordinary non-loopback submission", () => {
    expect(getEmailProviderConfiguration(productionConfiguration)).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      requireTls: true,
      user: "stonegate",
      pass: "private-password",
      from: "Stonegate <ops@example.test>",
      timeoutMs: 10_000,
    });
    expect(inspectEmailProviderConfiguration(productionConfiguration)).toEqual({
      configured: true,
      missing: [],
      invalid: [],
    });
  });

  it("allows an explicit controlled production-build test to use loopback", () => {
    const controlledConfiguration = {
      ...productionConfiguration,
      E2E_RUN_ID: "email-provider-contract",
      TEAM_CRM_AUDIT_MODE: "1",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
    };
    expect(
      getEmailProviderConfiguration(controlledConfiguration),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      requireTls: false,
    });
    expect(inspectEmailProviderConfiguration(controlledConfiguration)).toEqual({
      configured: true,
      missing: [],
      invalid: [],
    });
  });

  it.each([
    { E2E_RUN_ID: "email-provider-contract" },
    { TEAM_CRM_AUDIT_MODE: "1" },
    {
      E2E_RUN_ID: "email-provider-contract",
      TEAM_CRM_AUDIT_MODE: "true",
    },
  ])("rejects a partial production-build sentinel %j", (sentinels) => {
    expect(() =>
      getEmailProviderConfiguration({
        ...productionConfiguration,
        ...sentinels,
      }),
    ).toThrow("Production provider-test runtime requires both");
    expect(
      inspectEmailProviderConfiguration({
        ...productionConfiguration,
        ...sentinels,
      }),
    ).toMatchObject({ configured: false, missing: [] });
  });

  it("rejects loopback in ordinary production and public SMTP in controlled tests", () => {
    expect(() =>
      getEmailProviderConfiguration({
        ...productionConfiguration,
        SMTP_HOST: "localhost",
      }),
    ).toThrow("cannot target loopback in production");
    expect(() =>
      getEmailProviderConfiguration({
        ...productionConfiguration,
        NODE_ENV: "test",
        E2E_RUN_ID: "email-provider-contract",
      }),
    ).toThrow("must target a loopback service");
  });

  it.each([
    [{ SMTP_PORT: "not-a-port" }, "SMTP_PORT"],
    [{ SMTP_HOST: "smtp.example.test/path" }, "SMTP_HOST"],
    [{ SMTP_USER: "user", SMTP_PASS: "" }, "must either both be set"],
    [{ SMTP_FROM: "bad\nBcc: victim@example.test" }, "SMTP_FROM"],
    [{ SMTP_TIMEOUT_MS: "99" }, "SMTP_TIMEOUT_MS"],
    [{ SMTP_TIMEOUT_MS: "30001" }, "SMTP_TIMEOUT_MS"],
  ])("rejects malformed settings %j", (overrides, message) => {
    expect(() =>
      getEmailProviderConfiguration({
        ...productionConfiguration,
        ...overrides,
      }),
    ).toThrow(message);
  });

  it("recognizes every supported loopback form without accepting lookalikes", () => {
    expect(isLoopbackEmailHostname("localhost")).toBe(true);
    expect(isLoopbackEmailHostname("[::1]")).toBe(true);
    expect(isLoopbackEmailHostname("127.42.0.9")).toBe(true);
    expect(isLoopbackEmailHostname("mail.localhost")).toBe(true);
    expect(isLoopbackEmailHostname("localhost.example.test")).toBe(false);
    expect(isLoopbackEmailHostname("128.0.0.1")).toBe(false);
  });

  it("never downgrades thrown partial acceptance to a rejection", () => {
    expect(
      classifyEmailProviderError({
        responseCode: 550,
        accepted: ["accepted@stonegate.test"],
        rejected: ["rejected@stonegate.test"],
      }),
    ).toEqual({
      ok: false,
      deliveryCertainty: "ambiguous",
      providerMessageId: null,
      acceptedRecipientCount: 1,
      rejectedRecipientCount: 1,
      detail: "email_partial_acceptance",
    });
  });

  it("returns only structurally bounded, control-free message IDs", () => {
    expect(sanitizeEmailProviderMessageId("<safe-id@provider.example>")).toBe(
      "<safe-id@provider.example>",
    );
    for (const value of [
      "safe-id@provider.example",
      "<missing-domain@>",
      "<unsafe\r\nvalue@provider.example>",
      `<${"x".repeat(512)}@provider.example>`,
      null,
    ]) {
      expect(sanitizeEmailProviderMessageId(value)).toBeNull();
    }
  });
});
