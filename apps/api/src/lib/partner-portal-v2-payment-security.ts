import type { NextRequest } from "next/server";

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
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

/**
 * Payment endpoints require externally visible HTTPS in production. The
 * deployment proxy's normalized x-forwarded-proto value takes precedence over
 * the internal request URL. Loopback HTTP is accepted only outside production
 * so focused tests and local development do not need a trusted certificate.
 */
export function isSecurePartnerPaymentRequest(
  request: NextRequest,
  nodeEnvironment = process.env["NODE_ENV"],
): boolean {
  try {
    const url = new URL(request.url);
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      ?.trim()
      .toLowerCase()
      .replace(/:$/u, "");
    if (forwardedProtocol) {
      if (forwardedProtocol === "https") return true;
      if (forwardedProtocol !== "http") return false;
    } else if (url.protocol === "https:") {
      return true;
    }
    return (
      nodeEnvironment !== "production" &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}
