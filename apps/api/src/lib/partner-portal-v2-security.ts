import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function isPortalV2Uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

export function portalV2SessionHandle(sessionId: string): string {
  return createHash("sha256")
    .update("stonegate-partner-session-handle\0", "utf8")
    .update(sessionId, "utf8")
    .digest("base64url");
}

export function isPortalV2SessionHandle(value: unknown): value is string {
  return typeof value === "string" && SESSION_HANDLE_PATTERN.test(value);
}

export function sessionHandlesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizedOrigin(value: string | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Browser mutations must come from the API origin or the configured public
 * site. Requests without browser fetch metadata are retained for the existing
 * server-to-server site adapter, which authenticates with a bearer token.
 */
export function isAllowedPartnerPortalMutationOrigin(
  request: NextRequest,
): boolean {
  const originHeader = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!originHeader) return !fetchSite;

  const origin = normalizedOrigin(originHeader);
  if (!origin) return false;
  const allowed = new Set<string>();
  allowed.add(new URL(request.url).origin);
  const publicSite = resolvePublicSiteBaseUrl();
  const publicOrigin = normalizedOrigin(publicSite);
  if (publicOrigin) allowed.add(publicOrigin);
  // The browser-facing Site can differ from the canonical public-link origin
  // in local, preview, and private-network deployments. Both values are
  // operator-controlled configuration, so admit their exact origins without
  // trusting forwarding headers supplied by the caller.
  for (const configuredSite of [
    process.env["NEXT_PUBLIC_SITE_URL"],
    process.env["SITE_URL"],
  ]) {
    const configuredOrigin = normalizedOrigin(configuredSite ?? null);
    if (configuredOrigin) allowed.add(configuredOrigin);
  }
  return allowed.has(origin);
}

export function normalizedEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "");
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/u.test(domain)
    ? domain
    : null;
}

export function normalizeCompanyDomain(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) return null;
  try {
    const candidate = trimmed.includes("://")
      ? new URL(trimmed).hostname
      : new URL(`https://${trimmed}`).hostname;
    return normalizedEmailDomain(`person@${candidate.replace(/^www\./u, "")}`);
  } catch {
    return null;
  }
}
