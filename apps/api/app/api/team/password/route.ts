import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamSession, setTeamMemberPassword } from "@/lib/team-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const session = await requireTeamSession(request);
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.error }, { status: session.status });
  }

  const payload = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof payload?.password === "string" ? payload.password : "";
  if (!password || password.length < 10) {
    return NextResponse.json({ ok: false, error: "password_too_short" }, { status: 400 });
  }

  await setTeamMemberPassword(session.teamMember.id, password);
  return NextResponse.json({ ok: true });
}

