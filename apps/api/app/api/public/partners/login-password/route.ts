import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loginWithPassword, normalizeEmail } from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = normalizeEmail(payload?.email);
  const password = typeof payload?.password === "string" ? payload.password : null;
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  const session = await loginWithPassword(email, password, request, 30);
  if (!session) {
    return NextResponse.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, sessionToken: session.sessionToken });
}

