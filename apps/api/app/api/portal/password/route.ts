import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePartnerSession, setPartnerPassword } from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const payload = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof payload?.password === "string" ? payload.password : null;
  if (!password || password.length < 10) {
    return NextResponse.json({ ok: false, error: "password_too_short" }, { status: 400 });
  }

  await setPartnerPassword(auth.partnerUser.id, password);
  return NextResponse.json({ ok: true });
}

