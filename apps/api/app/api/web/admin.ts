import type { NextRequest } from "next/server";

export function isAdminRequest(request: NextRequest): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) {
    return false;
  }

  const headerKey =
    request.headers.get("x-api-key") ??
    request.headers.get("x-admin-api-key") ??
    request.headers.get("authorization");
  if (!headerKey) {
    return false;
  }

  if (headerKey.toLowerCase().startsWith("bearer ")) {
    return headerKey.slice(7).trim() === adminKey;
  }

  return headerKey.trim() === adminKey;
}
