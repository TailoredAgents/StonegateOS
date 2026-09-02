import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamSession } from "@/lib/team-auth";

export async function GET(request: NextRequest): Promise<Response> {
  const session = await requireTeamSession(request);
  if (!session.ok) {
    return NextResponse.json(
      { ok: false, error: session.error },
      { status: session.status },
    );
  }

  return NextResponse.json({
    ok: true,
    sessionId: session.sessionId,
    authMethod: session.authMethod,
    assuranceLevel: session.assuranceLevel,
    mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
    teamMember: session.teamMember,
  });
}
