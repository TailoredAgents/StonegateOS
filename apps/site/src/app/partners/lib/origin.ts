import type { NextRequest } from "next/server";
import { resolveRequestOrigin } from "../../../lib/request-origin";

export function resolvePublicOrigin(
  request: NextRequest,
  options: { configuredSiteUrls?: readonly (string | undefined)[] } = {},
): string {
  return resolveRequestOrigin(
    { headers: request.headers, url: request.nextUrl.origin },
    options,
  );
}
