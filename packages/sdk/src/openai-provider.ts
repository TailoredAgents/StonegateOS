import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type OpenAiProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type OpenAiApiEndpoint = "responses" | "audio/transcriptions";

export const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

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

export function getOpenAiApiBaseUrl(
  environment: OpenAiProviderEnvironment,
): URL {
  const configured = environment["OPENAI_API_BASE_URL"]?.trim();
  const raw = configured || DEFAULT_OPENAI_API_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENAI_API_BASE_URL must be a valid absolute URL.");
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "OPENAI_API_BASE_URL must not contain credentials, query parameters, or a fragment.",
    );
  }

  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const loopback = isLoopbackHostname(url.hostname);
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (production && loopback && !controlledTestMode) {
    throw new Error(
      "OPENAI_API_BASE_URL cannot target a loopback host in production.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "OPENAI_API_BASE_URL must use HTTPS unless it targets a loopback service.",
    );
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      "OPENAI_API_BASE_URL must target a loopback service during E2E or CRM audit runs.",
    );
  }

  return url;
}

export function resolveOpenAiApiEndpoint(
  endpoint: OpenAiApiEndpoint,
  environment: OpenAiProviderEnvironment,
): string {
  const base = getOpenAiApiBaseUrl(environment);
  const basePath = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${basePath}/${endpoint}`.replace(/\/{2,}/gu, "/");
  return base.toString();
}
