import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, teamMembers, teamRoles } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      roleId: teamMembers.roleId,
      active: teamMembers.active,
      createdAt: teamMembers.createdAt,
      updatedAt: teamMembers.updatedAt,
      roleName: teamRoles.name,
      roleSlug: teamRoles.slug
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .orderBy(asc(teamMembers.name));

  const members = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    role: row.roleId
      ? {
          id: row.roleId,
          name: row.roleName ?? null,
          slug: row.roleSlug ?? null
        }
      : null,
    active: row.active ?? true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }));

  return NextResponse.json({ members });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as {
    name?: string;
    email?: string;
    roleId?: string | null;
    active?: boolean;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }

  const email = typeof payload.email === "string" && payload.email.trim().length > 0 ? payload.email.trim() : null;
  const roleId = typeof payload.roleId === "string" && payload.roleId.trim().length > 0 ? payload.roleId.trim() : null;
  const active = typeof payload.active === "boolean" ? payload.active : true;

  const db = getDb();
  const [member] = await db
    .insert(teamMembers)
    .values({
      name,
      email,
      roleId,
      active,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .returning();

  if (!member) {
    return NextResponse.json({ error: "member_create_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "team_member.created",
    entityType: "team_member",
    entityId: member.id,
    meta: { roleId, active }
  });

  return NextResponse.json({
    member: {
      id: member.id,
      name: member.name,
      email: member.email ?? null,
      roleId: member.roleId ?? null,
      active: member.active ?? true
    }
  });
}
