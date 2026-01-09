import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, policySettings, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeE164(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("+")) return null;
  const digits = trimmed.slice(1).replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function readPhoneMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const phonesRaw = value["phones"];
  if (!isRecord(phonesRaw)) return {};
  const phones: Record<string, string> = {};
  for (const [key, raw] of Object.entries(phonesRaw)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      phones[key] = raw.trim();
    }
  }
  return phones;
}

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
    phone?: string | null;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  let phoneUpdate: { value: string | null } | null = null;

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

  if (payload.phone !== undefined) {
    if (payload.phone === null) {
      phoneUpdate = { value: null };
    } else if (typeof payload.phone === "string") {
      if (payload.phone.trim().length === 0) {
        phoneUpdate = { value: null };
      } else {
        const normalized = normalizeE164(payload.phone);
        if (!normalized) {
          return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        }
        phoneUpdate = { value: normalized };
      }
    } else {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  if (Object.keys(updates).length === 0 && !phoneUpdate) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  const db = getDb();
  const [member] = await db
    .transaction(async (tx) => {
      let updatedMember: typeof teamMembers.$inferSelect | null = null;

      if (Object.keys(updates).length > 0) {
        updates["updatedAt"] = new Date();
        const [row] = await tx
          .update(teamMembers)
          .set(updates)
          .where(eq(teamMembers.id, memberId))
          .returning();
        updatedMember = row ?? null;
      } else {
        const [row] = await tx.select().from(teamMembers).where(eq(teamMembers.id, memberId)).limit(1);
        updatedMember = row ?? null;
      }

      if (!updatedMember) {
        return [null] as const;
      }

      if (phoneUpdate) {
        const [existing] = await tx
          .select({ value: policySettings.value })
          .from(policySettings)
          .where(eq(policySettings.key, "team_member_phones"))
          .limit(1);

        const phoneMap = readPhoneMap(existing?.value);
        if (phoneUpdate.value) {
          phoneMap[memberId] = phoneUpdate.value;
        } else {
          delete phoneMap[memberId];
        }

        const actor = getAuditActorFromRequest(request);
        await tx
          .insert(policySettings)
          .values({
            key: "team_member_phones",
            value: { phones: phoneMap },
            updatedBy: actor.id ?? null
          })
          .onConflictDoUpdate({
            target: policySettings.key,
            set: {
              value: { phones: phoneMap },
              updatedBy: actor.id ?? null,
              updatedAt: new Date()
            }
          });
      }

      return [updatedMember] as const;
    });

  if (!member) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "team_member.updated",
    entityType: "team_member",
    entityId: memberId,
    meta: { updates, phone: phoneUpdate?.value ?? undefined }
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
