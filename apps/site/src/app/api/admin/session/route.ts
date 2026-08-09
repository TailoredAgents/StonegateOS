import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionMatches,
  adminSessionCookieOptions,
  getAdminSessionSecret,
} from "@/lib/admin-session";

export async function POST(request: NextRequest) {
  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret) {
    return NextResponse.json(
      { error: "admin_session_secret_missing" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const submitted =
    body && typeof body === "object" && "key" in body
      ? (body as { key?: unknown }).key
      : undefined;

  if (typeof submitted !== "string" || submitted.trim().length === 0) {
    return NextResponse.json({ error: "missing_key" }, { status: 400 });
  }

  if (!adminSessionMatches(submitted.trim())) {
    return NextResponse.json({ error: "invalid_key" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    ADMIN_SESSION_COOKIE,
    sessionSecret,
    adminSessionCookieOptions(),
  );
  return response;
}
