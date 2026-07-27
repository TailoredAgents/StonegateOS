type ResolveOptions = {
  /**
   * When true, dev can use `http://localhost:3000` as a fallback.
   * In production-like environments, we never return localhost/0.0.0.0 links.
   */
  devFallbackLocalhost?: boolean;
};

function isDevEnv(): boolean {
  const env = (process.env["NODE_ENV"] ?? "").toLowerCase();
  return env === "development" || env === "test";
}

function isProductionLike(): boolean {
  if (!isDevEnv()) return true;
  // Treat explicit Render deployments as production-like even if NODE_ENV is misconfigured.
  const render = (process.env["RENDER"] ?? "").toLowerCase();
  return render === "true" || render === "1";
}

function normalizeCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function isUnsafeHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return (
    lowered === "localhost" ||
    lowered === "127.0.0.1" ||
    lowered === "0.0.0.0" ||
    lowered === "::1"
  );
}

function resolveCandidate(raw: string | undefined): string | null {
  if (!raw) return null;
  const candidate = normalizeCandidate(raw);
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isUnsafeHost(url.hostname)) return null;
    if (isProductionLike() && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Base URL for customer-facing links (quotes, scheduling, partner portal).
 * - Uses the first safe value from `NEXT_PUBLIC_SITE_URL`, then `SITE_URL`
 * - Ensures we never emit localhost/0.0.0.0 links outside dev
 * - Requires HTTPS outside dev
 * - Returns the origin (no path/query)
 */
export function resolvePublicSiteBaseUrl(
  options: ResolveOptions = {},
): string | null {
  const candidates = [
    process.env["NEXT_PUBLIC_SITE_URL"],
    process.env["SITE_URL"],
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate);
    if (resolved) return resolved;
  }

  if (isDevEnv() && options.devFallbackLocalhost)
    return "http://localhost:3000";
  return null;
}

export function resolvePublicSiteBaseUrlOrThrow(): string {
  const base = resolvePublicSiteBaseUrl();
  if (!base) {
    throw new Error("public_site_url_not_configured");
  }
  return base;
}
