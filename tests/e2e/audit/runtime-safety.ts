import { getOpenAiApiBaseUrl } from "../../../packages/sdk/src/openai-provider";
import { getGoogleCalendarProviderEndpoints } from "../../../packages/sdk/src/google-calendar-provider";
import { getGoogleAdsProviderEndpoints } from "../../../packages/sdk/src/google-ads-provider";
import { getMetaGraphApiBaseUrl } from "../../../packages/sdk/src/meta-provider";
import { getSquareApiBaseUrl } from "../../../packages/sdk/src/square-provider";

type AuditEnvironment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_URL_VARIABLES = [
  "API_BASE_URL",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "OPENAI_API_BASE_URL",
  "OPENAI_FAKE_CONTROL_URL",
  "GOOGLE_CALENDAR_API_BASE_URL",
  "GOOGLE_CALENDAR_TOKEN_URL",
  "GOOGLE_CALENDAR_FAKE_CONTROL_URL",
  "GOOGLE_CALENDAR_WEBHOOK_URL",
  "TWILIO_API_BASE_URL",
  "TWILIO_FAKE_CONTROL_URL",
  "TWILIO_WEBHOOK_PUBLIC_BASE_URL",
  "LOCALSTACK_ENDPOINT",
  "MEDIA_OBJECT_ENDPOINT",
  "R2_ENDPOINT",
  "MAILHOG_UI",
  "EMAIL_FAKE_CONTROL_URL",
  "DM_WEBHOOK_URL",
  "GOOGLE_ADS_API_BASE_URL",
  "GOOGLE_ADS_TOKEN_URL",
  "GOOGLE_ADS_FAKE_CONTROL_URL",
  "SQUARE_API_BASE_URL",
  "SQUARE_FAKE_CONTROL_URL",
  "STRIPE_API_BASE_URL",
  "PLAID_API_BASE_URL",
  "META_API_BASE_URL",
  "FACEBOOK_GRAPH_API_BASE_URL",
  "META_FAKE_CONTROL_URL",
  "PUBLISHING_API_BASE_URL",
  "TRACCAR_BASE_URL",
] as const;

const OPTIONAL_PROVIDER_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_POS_STATE_SECRET",
  "PLAID_SECRET",
  "PLAID_CLIENT_ID",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
  "MAPBOX_ACCESS_TOKEN",
  "NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "DM_WEBHOOK_TOKEN",
  "PUBLISHING_API_TOKEN",
  "POSTHOG_API_KEY",
  "TRACCAR_API_TOKEN",
] as const;

const EXACT_E2E_SENTINELS: Readonly<Record<string, string>> = {
  SITE_URL: "https://stonegate.e2e.test",
  ADMIN_API_KEY: "e2e-admin-key",
  ADMIN_SESSION_SECRET: "e2e-admin-session-secret",
  CREW_SESSION_SECRET: "e2e-crew-session-secret",
  AGENT_BOT_SHARED_SECRET: "e2e-agent-bot-shared-secret",
  TEAM_AUTH_RATE_LIMIT_SECRET: "e2e-team-auth-rate-limit-secret-000000000000",
  TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN: "e2e-team-auth-rate-limit-bypass",
  OPENAI_API_KEY: "sk-e2e-example",
  STRIPE_SECRET_KEY: "sk_test_51NfXeSE2E0000000000000000000",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-test-token",
  TWILIO_FROM: "+15555550123",
  TWILIO_WEBHOOK_PUBLIC_BASE_URL: "http://localhost:3001",
  SMTP_USER: "mailhog",
  SMTP_PASS: "mailhog",
  EMAIL_FAKE_FORWARD_SMTP_HOST: "mailhog",
  EMAIL_FAKE_FORWARD_SMTP_PORT: "1025",
  MEDIA_OBJECT_ACCESS_KEY_ID: "test",
  MEDIA_OBJECT_SECRET_ACCESS_KEY: "test",
  MEDIA_OBJECT_AUTO_CREATE_BUCKET: "1",
  GOOGLE_CALENDAR_ENABLED: "1",
  GOOGLE_CLIENT_ID: "google-calendar-e2e-client",
  GOOGLE_CLIENT_SECRET: "google-calendar-e2e-client-secret",
  GOOGLE_REFRESH_TOKEN: "google-calendar-e2e-refresh-token",
  GOOGLE_CALENDAR_ID: "google-calendar-e2e-calendar",
  GOOGLE_ADS_DEVELOPER_TOKEN: "e2e-google-ads-developer-token",
  GOOGLE_ADS_CLIENT_ID: "e2e-google-ads-client",
  GOOGLE_ADS_CLIENT_SECRET: "e2e-google-ads-client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "e2e-google-ads-refresh-token",
  GOOGLE_ADS_CUSTOMER_ID: "0000000001",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "0000000002",
  GOOGLE_ADS_API_VERSION: "v25",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_ACCESS_TOKEN: "e2e-square-access-token",
  SQUARE_LOCATION_ID: "location-e2e-0001",
  FB_VERIFY_TOKEN: "e2e-meta-verify-token",
  FB_APP_SECRET: "e2e-meta-app-secret",
  FB_PAGE_ACCESS_TOKEN: "e2e-meta-page-token",
  FB_MESSENGER_ACCESS_TOKEN: "e2e-meta-system-token",
  FB_LEADGEN_ACCESS_TOKEN: "e2e-meta-leadgen-token",
  FB_MARKETING_ACCESS_TOKEN: "e2e-meta-marketing-token",
  META_CONVERSIONS_TOKEN: "e2e-meta-conversions-token",
  FB_PAGE_ID: "page-e2e-0001",
  FB_AD_ACCOUNT_ID: "000000000000001",
  META_DATASET_ID: "dataset-e2e-0001",
  META_LEAD_EVENT_SOURCE: "StonegateOS-E2E",
};

function trimmed(environment: AuditEnvironment, name: string): string | null {
  const value = environment[name]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function shareOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function addOptionalCredentialViolation(
  violations: string[],
  environment: AuditEnvironment,
  name: string,
  safe: (value: string) => boolean,
): void {
  const value = trimmed(environment, name);
  if (value && !safe(value)) {
    violations.push(`${name} is not an approved E2E sentinel credential.`);
  }
}

function addExactSentinelViolation(
  violations: string[],
  environment: AuditEnvironment,
  name: string,
  sentinel: string,
): void {
  if (trimmed(environment, name) !== sentinel) {
    violations.push(`${name} must exactly use the documented E2E sentinel.`);
  }
}

export function auditRuntimeSafetyViolations(
  environment: AuditEnvironment,
): string[] {
  const violations: string[] = [];

  if (!trimmed(environment, "E2E_RUN_ID")) {
    violations.push("E2E_RUN_ID is required.");
  }
  if (trimmed(environment, "TEAM_CRM_AUDIT_MODE") !== "1") {
    violations.push("TEAM_CRM_AUDIT_MODE must be exactly 1.");
  }
  const controlledAuditRuntime =
    Boolean(trimmed(environment, "E2E_RUN_ID")) &&
    trimmed(environment, "TEAM_CRM_AUDIT_MODE") === "1";
  const nodeEnvironment = trimmed(environment, "NODE_ENV")?.toLowerCase();
  if (nodeEnvironment === "production" && !controlledAuditRuntime) {
    violations.push(
      "NODE_ENV=production requires both E2E_RUN_ID and TEAM_CRM_AUDIT_MODE=1.",
    );
  } else if (nodeEnvironment !== "test" && nodeEnvironment !== "production") {
    violations.push("NODE_ENV must be test or controlled production.");
  }

  for (const name of LOOPBACK_URL_VARIABLES) {
    const value = trimmed(environment, name);
    if (value && !isLoopbackUrl(value)) {
      violations.push(`${name} must be a credential-free loopback URL.`);
    }
  }
  for (const [providerName, controlName] of [
    ["OPENAI_API_BASE_URL", "OPENAI_FAKE_CONTROL_URL"],
    ["TWILIO_API_BASE_URL", "TWILIO_FAKE_CONTROL_URL"],
    ["API_BASE_URL", "TWILIO_WEBHOOK_PUBLIC_BASE_URL"],
    ["GOOGLE_CALENDAR_API_BASE_URL", "GOOGLE_CALENDAR_FAKE_CONTROL_URL"],
    ["GOOGLE_CALENDAR_TOKEN_URL", "GOOGLE_CALENDAR_FAKE_CONTROL_URL"],
    ["API_BASE_URL", "GOOGLE_CALENDAR_WEBHOOK_URL"],
    ["GOOGLE_ADS_API_BASE_URL", "GOOGLE_ADS_FAKE_CONTROL_URL"],
    ["GOOGLE_ADS_TOKEN_URL", "GOOGLE_ADS_FAKE_CONTROL_URL"],
    ["SQUARE_API_BASE_URL", "SQUARE_FAKE_CONTROL_URL"],
    ["FACEBOOK_GRAPH_API_BASE_URL", "META_FAKE_CONTROL_URL"],
  ] as const) {
    const provider = trimmed(environment, providerName);
    const control = trimmed(environment, controlName);
    if (provider && control && !shareOrigin(provider, control)) {
      violations.push(`${controlName} must share the ${providerName} origin.`);
    }
  }
  const smtpHost = trimmed(environment, "SMTP_HOST");
  if (smtpHost && !isLoopbackHostname(smtpHost)) {
    violations.push("SMTP_HOST must be loopback-only.");
  }

  try {
    getOpenAiApiBaseUrl(environment);
  } catch {
    violations.push("OPENAI_API_BASE_URL is not safe for an E2E/audit run.");
  }
  try {
    getGoogleCalendarProviderEndpoints(environment);
  } catch {
    violations.push(
      "Google Calendar provider endpoints are not safe for an E2E/audit run.",
    );
  }
  try {
    getGoogleAdsProviderEndpoints(environment);
  } catch {
    violations.push(
      "Google Ads provider endpoints are not safe for an E2E/audit run.",
    );
  }
  try {
    getMetaGraphApiBaseUrl(environment);
  } catch {
    violations.push(
      "FACEBOOK_GRAPH_API_BASE_URL is not safe for an E2E/audit run.",
    );
  }
  try {
    getSquareApiBaseUrl(environment);
  } catch {
    violations.push("SQUARE_API_BASE_URL is not safe for an E2E/audit run.");
  }

  const squareEnabled = trimmed(environment, "SQUARE_POS_ENABLED");
  if (
    squareEnabled &&
    !["0", "false", "off", "no"].includes(squareEnabled.toLowerCase())
  ) {
    violations.push("SQUARE_POS_ENABLED must be disabled for E2E.");
  }
  const analyticsSentinels: Record<string, string> = {
    NEXT_PUBLIC_GA4_ID: "G-E2ETEST",
    GA4_MEASUREMENT_ID: "G-E2ETEST",
    NEXT_PUBLIC_META_PIXEL_ID: "E2EMETA123",
    GA4_API_SECRET: "e2e-ga4-secret",
  };
  for (const [name, sentinel] of Object.entries(analyticsSentinels)) {
    const value = trimmed(environment, name);
    if (value && value !== sentinel) {
      violations.push(
        `${name} must be blank or use the documented E2E sentinel.`,
      );
    }
  }

  for (const [name, sentinel] of Object.entries(EXACT_E2E_SENTINELS)) {
    addExactSentinelViolation(violations, environment, name, sentinel);
  }
  for (const name of OPTIONAL_PROVIDER_CREDENTIALS) {
    addOptionalCredentialViolation(violations, environment, name, () => false);
  }

  return [...new Set(violations)].sort();
}

export function assertSafeAuditRuntimeEnvironment(
  environment: AuditEnvironment,
): void {
  const violations = auditRuntimeSafetyViolations(environment);
  if (violations.length === 0) return;
  throw new Error(
    `Team audit environment is unsafe:\n- ${violations.join("\n- ")}`,
  );
}
