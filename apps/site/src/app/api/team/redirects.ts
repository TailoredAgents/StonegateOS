import type { NextRequest } from "next/server";

function getRequestOrigin(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.headers.get("x-forwarded-protocol") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host && host.trim().length) {
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
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

