import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { memberId } = await context.params;
  if (!memberId) {
    return NextResponse.json({ error: "member_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as {
    name?: string;
    email?: string | null;
    roleId?: string | null;
    active?: boolean;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (typeof payload.name === "string" && payload.name.trim().length > 0) {
    updates["name"] = payload.name.trim();
  }
  if (typeof payload.email === "string") {
    updates["email"] = payload.email.trim().length > 0 ? payload.email.trim() : null;
  }
  if (typeof payload.roleId === "string") {
    updates["roleId"] = payload.roleId.trim().length > 0 ? payload.roleId.trim() : null;
  } else if (payload.roleId === null) {
    updates["roleId"] = null;
  }
  if (typeof payload.active === "boolean") {
    updates["active"] = payload.active;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  updates["updatedAt"] = new Date();

  const db = getDb();
  const [member] = await db
    .update(teamMembers)
    .set(updates)
    .where(eq(teamMembers.id, memberId))
    .returning();

  if (!member) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "team_member.updated",
    entityType: "team_member",
    entityId: memberId,
    meta: { updates }
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

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { memberId } = await context.params;
  if (!memberId) {
    return NextResponse.json({ error: "member_id_required" }, { status: 400 });
  }

  const db = getDb();
  const [member] = await db
    .delete(teamMembers)
    .where(eq(teamMembers.id, memberId))
    .returning();

  if (!member) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "team_member.deleted",
    entityType: "team_member",
    entityId: memberId,
    meta: { name: member.name }
  });

  return NextResponse.json({ ok: true });
}
