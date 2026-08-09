import "dotenv/config";
import postgres from "postgres";
import { getGoogleCalendarProviderEndpoints } from "../packages/sdk/src/google-calendar-provider";
import { getGoogleAdsProviderEndpoints } from "../packages/sdk/src/google-ads-provider";
import { getMetaGraphApiBaseUrl } from "../packages/sdk/src/meta-provider";
import { getOpenAiApiBaseUrl } from "../packages/sdk/src/openai-provider";
import { getSquareApiBaseUrl } from "../packages/sdk/src/square-provider";
import { assertSafeAuditRuntimeEnvironment } from "../tests/e2e/audit/runtime-safety";

const MAX_ATTEMPTS = 60;
const RETRY_DELAY_MS = 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPostgres(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set before preparing E2E services.");
  }

  const sql = postgres(databaseUrl, {
    connect_timeout: 2,
    max: 1,
  });
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await sql`select 1`;
        console.info("[e2e] Postgres is ready.");
        return;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
        await delay(RETRY_DELAY_MS);
      }
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function waitForLocalStack(): Promise<void> {
  const endpoint =
    process.env["LOCALSTACK_ENDPOINT"]?.trim() ?? "http://localhost:4566";
  const healthUrl = new URL("/_localstack/health", endpoint);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] LocalStack is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("LocalStack did not become ready.");
}

async function waitForOpenAiFake(): Promise<void> {
  const providerBase = getOpenAiApiBaseUrl({
    ...process.env,
    E2E_RUN_ID: process.env["E2E_RUN_ID"]?.trim() || "e2e-services",
  });
  const endpoint =
    process.env["OPENAI_FAKE_CONTROL_URL"]?.trim() ?? "http://127.0.0.1:4011";
  const controlBase = new URL(endpoint);
  if (
    controlBase.origin !== providerBase.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "OPENAI_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as OPENAI_API_BASE_URL.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] OpenAI fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("OpenAI fake did not become ready.");
}

async function waitForGoogleCalendarFake(): Promise<void> {
  const endpoints = getGoogleCalendarProviderEndpoints({
    ...process.env,
    E2E_RUN_ID: process.env["E2E_RUN_ID"]?.trim() || "e2e-services",
  });
  const endpoint =
    process.env["GOOGLE_CALENDAR_FAKE_CONTROL_URL"]?.trim() ??
    "http://127.0.0.1:4012";
  const controlBase = new URL(endpoint);
  if (
    controlBase.origin !== endpoints.apiBaseUrl.origin ||
    controlBase.origin !== endpoints.tokenUrl.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "GOOGLE_CALENDAR_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as both Google Calendar provider endpoints.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Google Calendar fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Google Calendar fake did not become ready.");
}

async function waitForGoogleAdsFake(): Promise<void> {
  const endpoints = getGoogleAdsProviderEndpoints({
    ...process.env,
    E2E_RUN_ID: process.env["E2E_RUN_ID"]?.trim() || "e2e-services",
  });
  const endpoint =
    process.env["GOOGLE_ADS_FAKE_CONTROL_URL"]?.trim() ??
    "http://127.0.0.1:4014";
  const controlBase = new URL(endpoint);
  if (
    controlBase.origin !== endpoints.apiBaseUrl.origin ||
    controlBase.origin !== endpoints.tokenUrl.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "GOOGLE_ADS_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as both Google Ads provider endpoints.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Google Ads fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Google Ads fake did not become ready.");
}

async function waitForTwilioFake(): Promise<void> {
  const providerEndpoint =
    process.env["TWILIO_API_BASE_URL"]?.trim() ?? "http://127.0.0.1:4010";
  const controlEndpoint =
    process.env["TWILIO_FAKE_CONTROL_URL"]?.trim() ?? "http://127.0.0.1:4010";
  const providerBase = new URL(providerEndpoint);
  const controlBase = new URL(controlEndpoint);
  if (
    controlBase.origin !== providerBase.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "TWILIO_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as TWILIO_API_BASE_URL.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Twilio fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Twilio fake did not become ready.");
}

async function waitForSquareFake(): Promise<void> {
  const providerBase = getSquareApiBaseUrl({
    ...process.env,
    E2E_RUN_ID: process.env["E2E_RUN_ID"]?.trim() || "e2e-services",
  });
  const endpoint =
    process.env["SQUARE_FAKE_CONTROL_URL"]?.trim() ?? "http://127.0.0.1:4015";
  const controlBase = new URL(endpoint);
  if (
    controlBase.origin !== providerBase.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "SQUARE_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as SQUARE_API_BASE_URL.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Square fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Square fake did not become ready.");
}

async function waitForMetaFake(): Promise<void> {
  const providerBase = getMetaGraphApiBaseUrl({
    ...process.env,
    E2E_RUN_ID: process.env["E2E_RUN_ID"]?.trim() || "e2e-services",
  });
  const endpoint =
    process.env["META_FAKE_CONTROL_URL"]?.trim() ?? "http://127.0.0.1:4013";
  const controlBase = new URL(endpoint);
  if (
    controlBase.origin !== providerBase.origin ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "META_FAKE_CONTROL_URL must be a credential-free URL on the same loopback origin as FACEBOOK_GRAPH_API_BASE_URL.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Meta fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Meta fake did not become ready.");
}

async function waitForEmailFake(): Promise<void> {
  const endpoint =
    process.env["EMAIL_FAKE_CONTROL_URL"]?.trim() ?? "http://127.0.0.1:4016";
  const controlBase = new URL(endpoint);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(controlBase.hostname) ||
    controlBase.username ||
    controlBase.password ||
    controlBase.search ||
    controlBase.hash
  ) {
    throw new Error(
      "EMAIL_FAKE_CONTROL_URL must be a credential-free loopback URL.",
    );
  }
  const healthUrl = new URL("/healthz", controlBase);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] Email fake is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("Email fake did not become ready.");
}

async function main(): Promise<void> {
  assertSafeAuditRuntimeEnvironment(process.env);
  await Promise.all([
    waitForPostgres(),
    waitForLocalStack(),
    waitForOpenAiFake(),
    waitForGoogleCalendarFake(),
    waitForGoogleAdsFake(),
    waitForSquareFake(),
    waitForMetaFake(),
    waitForTwilioFake(),
    waitForEmailFake(),
  ]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
