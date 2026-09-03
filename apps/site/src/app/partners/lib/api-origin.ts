const LOCAL_PARTNER_API_BASE_URL = "http://localhost:3001";

type PartnerApiEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the trusted server-configured API base without accepting request
 * input. A missing production value fails closed instead of contacting the
 * site process or an implicit localhost service.
 */
export function resolvePartnerApiBaseUrl(
  environment: PartnerApiEnvironment = process.env,
): string | null {
  const configured =
    environment["API_BASE_URL"]?.trim() ||
    environment["NEXT_PUBLIC_API_BASE_URL"]?.trim() ||
    (environment["NODE_ENV"] === "production"
      ? ""
      : LOCAL_PARTNER_API_BASE_URL);
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function resolvePartnerApiUrl(
  path: `/${string}`,
  environment: PartnerApiEnvironment = process.env,
): string | null {
  const base = resolvePartnerApiBaseUrl(environment);
  return base ? `${base}${path}` : null;
}
