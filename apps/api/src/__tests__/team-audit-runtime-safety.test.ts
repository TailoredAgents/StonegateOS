import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import {
  assertSafeAuditRuntimeEnvironment,
  auditRuntimeSafetyViolations,
} from "../../../../tests/e2e/audit/runtime-safety";

const ROOT = resolve(process.cwd(), "../..");

describe("Team audit runtime environment safety", () => {
  it("accepts the repository's documented E2E sentinels", () => {
    const environment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    expect(auditRuntimeSafetyViolations(environment)).toEqual([]);
    expect(() => assertSafeAuditRuntimeEnvironment(environment)).not.toThrow();
  });

  it("prevents browser analytics sentinels from reaching real providers", () => {
    const googleTag = readFileSync(
      resolve(ROOT, "apps/site/src/components/GoogleTag.tsx"),
      "utf8",
    );
    const metaPixel = readFileSync(
      resolve(ROOT, "apps/site/src/components/MetaPixel.tsx"),
      "utf8",
    );

    expect(googleTag).toContain('"G-E2ETEST"');
    expect(googleTag).toContain("AUDIT_SENTINEL_TAG_IDS.has(normalized)");
    expect(metaPixel).toContain("/^\\d{5,32}$/u.test(sanitized)");
  });

  it("accepts the same loopback-only providers and LocalStack for a controlled production artifact", () => {
    const environment = {
      ...parse(readFileSync(resolve(ROOT, ".env.e2e"))),
      NODE_ENV: "production",
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "1",
    };

    expect(auditRuntimeSafetyViolations(environment)).toEqual([]);
    expect(() => assertSafeAuditRuntimeEnvironment(environment)).not.toThrow();
  });

  it.each([
    {
      label: "run identity only",
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: undefined,
    },
    {
      label: "audit flag only",
      E2E_RUN_ID: undefined,
      TEAM_CRM_AUDIT_MODE: "1",
    },
    {
      label: "non-exact audit flag",
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "true",
    },
  ])(
    "rejects controlled production with $label",
    ({ E2E_RUN_ID, TEAM_CRM_AUDIT_MODE }) => {
      const environment = {
        ...parse(readFileSync(resolve(ROOT, ".env.e2e"))),
        NODE_ENV: "production",
        E2E_RUN_ID,
        TEAM_CRM_AUDIT_MODE,
      };
      const violations = auditRuntimeSafetyViolations(environment);
      expect(violations).toContain(
        "NODE_ENV=production requires both E2E_RUN_ID and TEAM_CRM_AUDIT_MODE=1.",
      );
      expect(violations).toEqual(
        expect.arrayContaining([
          "OPENAI_API_BASE_URL is not safe for an E2E/audit run.",
          "SQUARE_API_BASE_URL is not safe for an E2E/audit run.",
        ]),
      );
    },
  );

  it("keeps Site legacy-exchange sentinels aligned with the guarded root environment", () => {
    const rootEnvironment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    const siteEnvironment = parse(
      readFileSync(resolve(ROOT, "apps/site/.env.e2e.local")),
    );
    for (const name of [
      "ADMIN_API_KEY",
      "ADMIN_SESSION_SECRET",
      "CREW_SESSION_SECRET",
    ]) {
      expect(siteEnvironment[name]).toBe(rootEnvironment[name]);
    }
  });

  it("propagates both production-build audit sentinels to Site and API runtimes", () => {
    const rootEnvironment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    const runtimeEnvironments = [
      parse(readFileSync(resolve(ROOT, "apps/site/.env.e2e.local"))),
      parse(readFileSync(resolve(ROOT, "apps/api/.env.e2e.local"))),
    ];

    expect(rootEnvironment["TEAM_CRM_AUDIT_MODE"]).toBe("1");
    for (const environment of runtimeEnvironments) {
      expect(environment["E2E_RUN_ID"]).toBe(rootEnvironment["E2E_RUN_ID"]);
      expect(environment["TEAM_CRM_AUDIT_MODE"]).toBe("1");
    }
  });

  it("rejects production mode, live-looking credentials, and public provider URLs without echoing secrets", () => {
    const secret = "sk-live-private-value-must-not-be-printed";
    const googleSecret = "live-google-client-secret-must-not-be-printed";
    const googleAdsSecret = "live-google-ads-client-secret-must-not-be-printed";
    const environment = {
      E2E_RUN_ID: "audit-test",
      NODE_ENV: "production",
      OPENAI_API_KEY: secret,
      OPENAI_API_BASE_URL: "https://api.openai.com/v1",
      TWILIO_ACCOUNT_SID: "AC-not-a-real-account-sid",
      TWILIO_API_BASE_URL: "https://api.twilio.com",
      GOOGLE_CALENDAR_API_BASE_URL: "https://www.googleapis.com/calendar/v3",
      GOOGLE_CALENDAR_TOKEN_URL: "https://oauth2.googleapis.com/token",
      GOOGLE_CLIENT_SECRET: googleSecret,
      GOOGLE_ADS_API_BASE_URL: "https://googleads.googleapis.com",
      GOOGLE_ADS_TOKEN_URL: "https://oauth2.googleapis.com/token",
      GOOGLE_ADS_CLIENT_SECRET: googleAdsSecret,
      SMTP_HOST: "smtp.example.com",
      SQUARE_POS_ENABLED: "1",
      SQUARE_ENVIRONMENT: "production",
      STRIPE_SECRET_KEY: "sk_live_secret",
      NEXT_PUBLIC_GA4_ID: "G-REALVALUE",
      FB_PAGE_ACCESS_TOKEN: "private-provider-token",
    };

    const violations = auditRuntimeSafetyViolations(environment);
    expect(violations).toEqual(
      expect.arrayContaining([
        "TEAM_CRM_AUDIT_MODE must be exactly 1.",
        "NODE_ENV=production requires both E2E_RUN_ID and TEAM_CRM_AUDIT_MODE=1.",
        "OPENAI_API_BASE_URL must be a credential-free loopback URL.",
        "TWILIO_API_BASE_URL must be a credential-free loopback URL.",
        "GOOGLE_CALENDAR_API_BASE_URL must be a credential-free loopback URL.",
        "GOOGLE_CALENDAR_TOKEN_URL must be a credential-free loopback URL.",
        "GOOGLE_ADS_API_BASE_URL must be a credential-free loopback URL.",
        "GOOGLE_ADS_TOKEN_URL must be a credential-free loopback URL.",
        "SMTP_HOST must be loopback-only.",
        "SQUARE_POS_ENABLED must be disabled for E2E.",
        "SQUARE_ENVIRONMENT must exactly use the documented E2E sentinel.",
      ]),
    );
    let message = "";
    try {
      assertSafeAuditRuntimeEnvironment(environment);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Team audit environment is unsafe");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(googleSecret);
    expect(message).not.toContain(googleAdsSecret);
    expect(message).not.toContain("private-provider-token");
  });

  it("rejects ambient overrides of exact sentinels and any undocumented provider credential", () => {
    const environment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    const adminSecret = "ambient-admin-secret";
    const storageSecret = "ambient-r2-secret";
    const violations = auditRuntimeSafetyViolations({
      ...environment,
      ADMIN_API_KEY: adminSecret,
      R2_SECRET_ACCESS_KEY: storageSecret,
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        "ADMIN_API_KEY must exactly use the documented E2E sentinel.",
        "R2_SECRET_ACCESS_KEY is not an approved E2E sentinel credential.",
      ]),
    );
    expect(() =>
      assertSafeAuditRuntimeEnvironment({
        ...environment,
        ADMIN_API_KEY: adminSecret,
        R2_SECRET_ACCESS_KEY: storageSecret,
      }),
    ).toThrow();

    try {
      assertSafeAuditRuntimeEnvironment({
        ...environment,
        ADMIN_API_KEY: adminSecret,
        R2_SECRET_ACCESS_KEY: storageSecret,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(adminSecret);
      expect(message).not.toContain(storageSecret);
    }
  });

  it("rejects an arbitrary email-fake relay host and port", () => {
    const environment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        EMAIL_FAKE_FORWARD_SMTP_HOST: "smtp.live.example",
        EMAIL_FAKE_FORWARD_SMTP_PORT: "587",
      }),
    ).toEqual(
      expect.arrayContaining([
        "EMAIL_FAKE_FORWARD_SMTP_HOST must exactly use the documented E2E sentinel.",
        "EMAIL_FAKE_FORWARD_SMTP_PORT must exactly use the documented E2E sentinel.",
      ]),
    );
  });

  it("rejects credential-bearing, queried, fragmented, and non-loopback mock endpoints", () => {
    for (const endpoint of [
      "https://mock.example.test",
      "http://user:secret@127.0.0.1:4010",
      "http://127.0.0.1:4010?secret=value",
      "http://127.0.0.1:4010#fragment",
    ]) {
      expect(
        auditRuntimeSafetyViolations({
          E2E_RUN_ID: "audit-test",
          OPENAI_API_KEY: "sk-e2e-example",
          OPENAI_API_BASE_URL: "http://127.0.0.1:4011/v1",
          TWILIO_API_BASE_URL: endpoint,
        }),
      ).toContain(
        "TWILIO_API_BASE_URL must be a credential-free loopback URL.",
      );
    }
  });

  it("requires fake controls to share their provider origin", () => {
    const environment = parse(readFileSync(resolve(ROOT, ".env.e2e")));
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        TWILIO_FAKE_CONTROL_URL: "http://127.0.0.1:4999",
      }),
    ).toContain(
      "TWILIO_FAKE_CONTROL_URL must share the TWILIO_API_BASE_URL origin.",
    );
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        OPENAI_FAKE_CONTROL_URL: "http://127.0.0.1:4998",
      }),
    ).toContain(
      "OPENAI_FAKE_CONTROL_URL must share the OPENAI_API_BASE_URL origin.",
    );
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        GOOGLE_CALENDAR_FAKE_CONTROL_URL: "http://127.0.0.1:4997",
      }),
    ).toEqual(
      expect.arrayContaining([
        "GOOGLE_CALENDAR_FAKE_CONTROL_URL must share the GOOGLE_CALENDAR_API_BASE_URL origin.",
        "GOOGLE_CALENDAR_FAKE_CONTROL_URL must share the GOOGLE_CALENDAR_TOKEN_URL origin.",
      ]),
    );
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        SQUARE_FAKE_CONTROL_URL: "http://127.0.0.1:4994",
      }),
    ).toContain(
      "SQUARE_FAKE_CONTROL_URL must share the SQUARE_API_BASE_URL origin.",
    );
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        META_FAKE_CONTROL_URL: "http://127.0.0.1:4996",
      }),
    ).toContain(
      "META_FAKE_CONTROL_URL must share the FACEBOOK_GRAPH_API_BASE_URL origin.",
    );
    expect(
      auditRuntimeSafetyViolations({
        ...environment,
        GOOGLE_ADS_FAKE_CONTROL_URL: "http://127.0.0.1:4995",
      }),
    ).toEqual(
      expect.arrayContaining([
        "GOOGLE_ADS_FAKE_CONTROL_URL must share the GOOGLE_ADS_API_BASE_URL origin.",
        "GOOGLE_ADS_FAKE_CONTROL_URL must share the GOOGLE_ADS_TOKEN_URL origin.",
      ]),
    );
  });

  it("requires an explicit run identity and detects ambient analytics replacement", () => {
    expect(
      auditRuntimeSafetyViolations({
        NODE_ENV: "test",
        OPENAI_API_KEY: "sk-e2e-example",
        OPENAI_API_BASE_URL: "http://127.0.0.1:4011/v1",
        NEXT_PUBLIC_META_PIXEL_ID: "real-pixel-id",
      }),
    ).toEqual(
      expect.arrayContaining([
        "E2E_RUN_ID is required.",
        "NEXT_PUBLIC_META_PIXEL_ID must be blank or use the documented E2E sentinel.",
      ]),
    );
  });

  it("runs the provider boundary before any destructive audit setup", () => {
    const source = readFileSync(
      resolve(ROOT, "tests/e2e/audit/global-setup.ts"),
      "utf8",
    );
    const runtimeGuard = source.indexOf(
      "assertSafeAuditRuntimeEnvironment(environment)",
    );
    const databaseGuard = source.indexOf(
      "assertSafeAuditSeedDatabase()",
      runtimeGuard,
    );
    const seed = source.indexOf("await runE2ESeed()", databaseGuard);

    expect(runtimeGuard).toBeGreaterThan(-1);
    expect(databaseGuard).toBeGreaterThan(runtimeGuard);
    expect(seed).toBeGreaterThan(databaseGuard);
  });

  it("publishes every local audit dependency on loopback only", () => {
    const compose = readFileSync(
      resolve(ROOT, "devops/docker-compose.yml"),
      "utf8",
    );
    const publishedPorts = compose
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- "') && line.endsWith('"'));

    expect(publishedPorts.length).toBeGreaterThanOrEqual(8);
    expect(publishedPorts).toEqual(
      expect.arrayContaining([
        '- "127.0.0.1:${PG_PORT:-5432}:5432"',
        '- "127.0.0.1:${TWILIO_HTTP_PORT:-4010}:4010"',
        '- "127.0.0.1:${OPENAI_HTTP_PORT:-4011}:4011"',
        '- "127.0.0.1:${GOOGLE_CALENDAR_HTTP_PORT:-4012}:4012"',
        '- "127.0.0.1:${META_HTTP_PORT:-4013}:4013"',
        '- "127.0.0.1:${GOOGLE_ADS_HTTP_PORT:-4014}:4014"',
        '- "127.0.0.1:${SQUARE_HTTP_PORT:-4015}:4015"',
      ]),
    );
    expect(
      publishedPorts.every((line) => line.startsWith('- "127.0.0.1:')),
    ).toBe(true);
  });
});
