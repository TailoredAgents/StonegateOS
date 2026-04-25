import type { NextRequest } from "next/server";

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function mobileLoginRedirectUrl(request: NextRequest, path: string): URL {
  const configured = normalizeOrigin(process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "");
  if (configured) return new URL(path, configured);

  const forwardedProto = (request.headers.get("x-forwarded-proto") ?? "")
    .split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  const forwarded = normalizeOrigin(`${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`);
  if (forwarded) return new URL(path, forwarded);

  const fallback = normalizeOrigin(request.nextUrl.origin) ?? "https://stonegatejunkremoval.com";
  return new URL(path, fallback);
}
