import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { revokeTeamSession } from "@/lib/team-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  await revokeTeamSession(token);
  return NextResponse.json({ ok: true });
}

