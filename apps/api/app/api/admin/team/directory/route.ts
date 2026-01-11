import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const db = getDb();
  const members = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      active: teamMembers.active,
      defaultCrewSplitBps: teamMembers.defaultCrewSplitBps
    })
    .from(teamMembers)
    .where(eq(teamMembers.active, true))
    .orderBy(asc(teamMembers.name));

  return NextResponse.json({
    ok: true,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      defaultCrewSplitBps: m.defaultCrewSplitBps ?? null
    }))
  });
}

