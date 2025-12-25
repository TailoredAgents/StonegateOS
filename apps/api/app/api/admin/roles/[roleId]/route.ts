import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, teamRoles } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ roleId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { roleId } = await context.params;
  if (!roleId) {
    return NextResponse.json({ error: "role_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as {
    name?: string;
    slug?: string;
    permissions?: string[];
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof payload.name === "string" && payload.name.trim().length > 0) {
    updates["name"] = payload.name.trim();
  }
  if (typeof payload.slug === "string" && payload.slug.trim().length > 0) {
    updates["slug"] = payload.slug.trim();
  }
  if (Array.isArray(payload.permissions)) {
    updates["permissions"] = payload.permissions.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
    );
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  updates["updatedAt"] = new Date();

  const db = getDb();
  const [role] = await db
    .update(teamRoles)
    .set(updates)
    .where(eq(teamRoles.id, roleId))
    .returning();

  if (!role) {
    return NextResponse.json({ error: "role_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "role.updated",
    entityType: "team_role",
    entityId: roleId,
    meta: { updates }
  });

  return NextResponse.json({
    role: {
      id: role.id,
      name: role.name,
      slug: role.slug,
      permissions: role.permissions ?? []
    }
  });
}
