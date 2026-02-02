import type { NextRequest } from "next/server";

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const lowered = url.hostname.toLowerCase();
    if (lowered === "localhost" || lowered === "127.0.0.1" || lowered === "0.0.0.0") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getRequestOrigin(request: NextRequest): string {
  const forwardedProto = (request.headers.get("x-forwarded-proto") ?? request.headers.get("x-forwarded-protocol") ?? "")
    .split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();

  if (forwardedHost) {
    const raw = `${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`;
    const normalized = normalizeBaseUrl(raw);
    if (normalized) return normalized;
  }

  const env = normalizeBaseUrl(process.env["NEXT_PUBLIC_SITE_URL"] ?? "");
  if (env) return env;

  // Last resort (can be wrong on some hosts, but better than throwing).
  return request.nextUrl.origin;
}

export function getSafeRedirectUrl(request: NextRequest, fallbackPath = "/team?tab=owner"): URL {
  const origin = getRequestOrigin(request);
  const fallback = new URL(fallbackPath, origin);
  const referer = request.headers.get("referer");
  if (!referer) return fallback;

  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== fallback.origin) return fallback;
    return refererUrl;
  } catch {
    return fallback;
  }
}
