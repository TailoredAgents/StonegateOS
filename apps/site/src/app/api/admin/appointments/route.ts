import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, adminSessionMatches } from "@/lib/admin-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

function hasOwnerSession(request: NextRequest): boolean {
  return adminSessionMatches(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!hasOwnerSession(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const apiKey = process.env["ADMIN_API_KEY"]?.trim() ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "admin_api_unavailable" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const base = API_BASE_URL.replace(/\/$/, "");

  const upstream = await fetch(
    `${base}/api/appointments?status=${encodeURIComponent(status)}`,
    {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    },
  );

  const body: unknown = await upstream.json().catch(() => ({ ok: false }));
  return NextResponse.json(body, { status: upstream.status });
}
