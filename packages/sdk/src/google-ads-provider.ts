import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type GoogleAdsProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type GoogleAdsApiEndpoint =
  | { kind: "accessible_customers"; apiVersion: string }
  | { kind: "search_stream"; apiVersion: string; customerId: string }
  | {
      kind: "mutate_customer_negative_criteria";
      apiVersion: string;
      customerId: string;
    };

export const DEFAULT_GOOGLE_ADS_API_BASE_URL =
  "https://googleads.googleapis.com";
export const DEFAULT_GOOGLE_ADS_TOKEN_URL =
  "https://oauth2.googleapis.com/token";

export type GoogleAdsProviderEndpoints = {
  apiBaseUrl: URL;
  tokenUrl: URL;
};

export function isLoopbackGoogleAdsHostname(hostname: string): boolean {
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
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

function parseProviderUrl(
  variableName: string,
  configured: string | undefined,
  fallback: string,
): URL {
  let url: URL;
  try {
    url = new URL(configured?.trim() || fallback);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL.`);
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${variableName} must not contain credentials, query parameters, or a fragment.`,
    );
  }
  return url;
}

function validateProviderUrl(
  variableName: string,
  url: URL,
  environment: GoogleAdsProviderEnvironment,
): void {
  const loopback = isLoopbackGoogleAdsHostname(url.hostname);
  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (production && loopback && !controlledTestMode) {
    throw new Error(
      `${variableName} cannot target a loopback host in production.`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `${variableName} must use HTTPS unless it targets a loopback service.`,
    );
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      `${variableName} must target a loopback service during E2E or CRM audit runs.`,
    );
  }
}

export function getGoogleAdsProviderEndpoints(
  environment: GoogleAdsProviderEnvironment,
): GoogleAdsProviderEndpoints {
  const apiBaseUrl = parseProviderUrl(
    "GOOGLE_ADS_API_BASE_URL",
    environment["GOOGLE_ADS_API_BASE_URL"],
    DEFAULT_GOOGLE_ADS_API_BASE_URL,
  );
  const tokenUrl = parseProviderUrl(
    "GOOGLE_ADS_TOKEN_URL",
    environment["GOOGLE_ADS_TOKEN_URL"],
    DEFAULT_GOOGLE_ADS_TOKEN_URL,
  );

  validateProviderUrl("GOOGLE_ADS_API_BASE_URL", apiBaseUrl, environment);
  validateProviderUrl("GOOGLE_ADS_TOKEN_URL", tokenUrl, environment);
  if (
    isControlledProviderTestRuntime(environment) &&
    apiBaseUrl.origin !== tokenUrl.origin
  ) {
    throw new Error(
      "GOOGLE_ADS_API_BASE_URL and GOOGLE_ADS_TOKEN_URL must share one loopback origin during E2E or CRM audit runs.",
    );
  }

  return { apiBaseUrl, tokenUrl };
}

function normalizedApiVersion(value: string): string {
  const version = value.trim();
  if (!/^v[1-9]\d*$/u.test(version)) {
    throw new Error("apiVersion must use the Google Ads v<number> format.");
  }
  return version;
}

function normalizedCustomerId(value: string): string {
  const supplied = value.trim();
  if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/u.test(supplied)) {
    throw new Error("customerId must contain exactly ten digits.");
  }
  return supplied.replaceAll("-", "");
}

export function resolveGoogleAdsApiEndpoint(
  endpoint: GoogleAdsApiEndpoint,
  environment: GoogleAdsProviderEnvironment,
): string {
  const { apiBaseUrl } = getGoogleAdsProviderEndpoints(environment);
  const basePath = apiBaseUrl.pathname.replace(/\/+$/u, "");
  const apiVersion = normalizedApiVersion(endpoint.apiVersion);
  let suffix: string;
  if (endpoint.kind === "accessible_customers") {
    suffix = `/${apiVersion}/customers:listAccessibleCustomers`;
  } else {
    const customerId = normalizedCustomerId(endpoint.customerId);
    suffix =
      endpoint.kind === "search_stream"
        ? `/${apiVersion}/customers/${customerId}/googleAds:searchStream`
        : `/${apiVersion}/customers/${customerId}/customerNegativeCriteria:mutate`;
  }
  apiBaseUrl.pathname = `${basePath}${suffix}`.replace(/\/{2,}/gu, "/");
  return apiBaseUrl.toString();
}

export function resolveGoogleAdsTokenEndpoint(
  environment: GoogleAdsProviderEnvironment,
): string {
  return getGoogleAdsProviderEndpoints(environment).tokenUrl.toString();
}
