import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exchangePartnerLoginToken } from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const rawToken = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!rawToken) {
    return NextResponse.json({ ok: false, error: "token_required" }, { status: 400 });
  }

  const result = await exchangePartnerLoginToken(rawToken, request, 30);
  if (!result) {
    return NextResponse.json({ ok: false, error: "invalid_or_expired" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    sessionToken: result.sessionToken,
    needsPasswordSetup: result.needsPasswordSetup
  });
}

