import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

function hasOwnerSession(request: NextRequest): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  return request.cookies.get(ADMIN_SESSION_COOKIE)?.value === adminKey;
}

export async function GET(request: NextRequest): Promise<Response> {
  const adminKey = getAdminKey();
  if (!adminKey) {
    return NextResponse.json({ error: "admin_key_missing" }, { status: 500 });
  }
  if (!hasOwnerSession(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const base = API_BASE_URL.replace(/\/$/, "");

  const upstream = await fetch(`${base}/api/appointments?status=${encodeURIComponent(status)}`, {
    headers: { "x-api-key": adminKey },
    cache: "no-store"
  });

  const body = await upstream.json().catch(() => ({ ok: false }));
  return NextResponse.json(body, { status: upstream.status });
}
