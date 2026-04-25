import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { resolveMobileSessionFromToken } from "../../../mobile/lib/session";

export async function GET(request: NextRequest): Promise<Response> {
  const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? "";
  const session = await resolveMobileSessionFromToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    teamMember: session.teamMember,
    allowedScreens: session.allowedScreens,
    isOwner: session.isOwner
  });
}
