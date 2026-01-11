import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode = direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? (direct["cause"] as Record<string, unknown>) : null;
  const causeCode = cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const db = getDb();
  let members: Array<{ id: string; name: string; active: boolean | null; defaultCrewSplitBps: number | null }> = [];
  try {
    members = await db
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        active: teamMembers.active,
        defaultCrewSplitBps: teamMembers.defaultCrewSplitBps
      })
      .from(teamMembers)
      .where(eq(teamMembers.active, true))
      .orderBy(asc(teamMembers.name));
  } catch (error) {
    const code = extractPgCode(error);
    if (code !== "42703") {
      throw error;
    }
    const fallback = await db
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        active: teamMembers.active
      })
      .from(teamMembers)
      .where(eq(teamMembers.active, true))
      .orderBy(asc(teamMembers.name));
    members = fallback.map((row) => ({ ...row, defaultCrewSplitBps: null }));
  }

  return NextResponse.json({
    ok: true,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      defaultCrewSplitBps: m.defaultCrewSplitBps ?? null
    }))
  });
}
