import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type MetaProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export const DEFAULT_META_GRAPH_API_BASE_URL = "https://graph.facebook.com";
export const META_GRAPH_API_VERSION = "v24.0";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^::ffff:127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized) ||
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

function normalizedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed === "/" ? "" : trimmed;
}

/**
 * Resolve and validate the one base URL used for every Meta Graph request.
 * Provider credentials belong in request parameters, never in this URL.
 */
export function getMetaGraphApiBaseUrl(
  environment: MetaProviderEnvironment,
): URL {
  const configured = environment["FACEBOOK_GRAPH_API_BASE_URL"]?.trim();
  const raw = configured || DEFAULT_META_GRAPH_API_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "FACEBOOK_GRAPH_API_BASE_URL must be a valid absolute URL.",
    );
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "FACEBOOK_GRAPH_API_BASE_URL must not contain credentials, query parameters, or a fragment.",
    );
  }

  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const loopback = isLoopbackHostname(url.hostname);
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (production && loopback && !controlledTestMode) {
    throw new Error(
      "FACEBOOK_GRAPH_API_BASE_URL cannot target a loopback host in production.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "FACEBOOK_GRAPH_API_BASE_URL must use HTTPS unless it targets a loopback service.",
    );
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      "FACEBOOK_GRAPH_API_BASE_URL must target a loopback service during E2E or CRM audit runs.",
    );
  }

  url.pathname = normalizedBasePath(url.pathname) || "/";
  return url;
}

export function resolveMetaGraphApiEndpoint(
  pathSegments: readonly string[],
  environment: MetaProviderEnvironment,
  options: { versioned?: boolean } = {},
): string {
  if (pathSegments.length === 0) {
    throw new Error("A Meta Graph API endpoint path is required.");
  }
  const safeSegments = pathSegments.map((segment) => {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") {
      throw new Error("Meta Graph API endpoint segments must be non-empty.");
    }
    return encodeURIComponent(trimmed);
  });

  const base = getMetaGraphApiBaseUrl(environment);
  const basePath = normalizedBasePath(base.pathname);
  const versionPrefix =
    options.versioned === false ? "" : `/${META_GRAPH_API_VERSION}`;
  base.pathname = `${basePath}${versionPrefix}/${safeSegments.join("/")}`;
  return base.toString();
}

/**
 * Meta Ads pagination supplies a complete URL. Keep it on the configured
 * provider origin and within the versioned Graph namespace to prevent SSRF.
 */
export function validateMetaGraphPaginationUrl(
  candidate: string,
  environment: MetaProviderEnvironment,
): string {
  const base = getMetaGraphApiBaseUrl(environment);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Meta Graph pagination URL must be a valid absolute URL.");
  }

  const basePath = normalizedBasePath(base.pathname);
  const requiredPrefix = `${basePath}/${META_GRAPH_API_VERSION}/`;
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(requiredPrefix)
  ) {
    throw new Error(
      "Meta Graph pagination URL must remain on the configured versioned provider origin.",
    );
  }

  return url.toString();
}
