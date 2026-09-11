import type { NextRequest } from "next/server";

import { resolveRequestOrigin } from "../../../lib/request-origin";

export function getSafeRedirectUrl(
  request: NextRequest,
  fallbackPath = "/team?tab=owner",
): URL {
  const origin = resolveRequestOrigin(request);
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
