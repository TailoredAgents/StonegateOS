import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, policySettings, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { SALES_SCORECARD_POLICY_KEY } from "@/lib/sales-scorecard";

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

const MEMBER_SELECT = {
  id: teamMembers.id,
  name: teamMembers.name,
  email: teamMembers.email,
  roleId: teamMembers.roleId,
  active: teamMembers.active
} as const;

function normalizePhoneInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Allow US 10-digit numbers without +1.
  if (/^\d{10}$/.test(trimmed)) {
    return `+1${trimmed}`;
  }

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/[^\d]/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }

  // Allow common formatted US numbers like (678) 555-1212 or 678-555-1212.
  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }

  return null;
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

function readDefaultAssignee(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const raw = value["defaultAssigneeMemberId"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    defaultCrewSplitBps?: number | null;
    permissionsGrant?: string[] | null;
    permissionsDeny?: string[] | null;
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
    updates["email"] = payload.email.trim().length > 0 ? payload.email.trim().toLowerCase() : null;
  }
  if (typeof payload.roleId === "string") {
    updates["roleId"] = payload.roleId.trim().length > 0 ? payload.roleId.trim() : null;
  } else if (payload.roleId === null) {
    updates["roleId"] = null;
  }
  if (typeof payload.active === "boolean") {
    updates["active"] = payload.active;
  }
  if (payload.defaultCrewSplitBps !== undefined) {
    if (payload.defaultCrewSplitBps === null) {
      updates["defaultCrewSplitBps"] = null;
    } else if (typeof payload.defaultCrewSplitBps === "number") {
      const value = Math.round(payload.defaultCrewSplitBps);
      if (!Number.isFinite(value) || value < 0 || value > 10000) {
        return NextResponse.json({ error: "invalid_default_crew_split" }, { status: 400 });
      }
      updates["defaultCrewSplitBps"] = value;
    } else {
      return NextResponse.json({ error: "invalid_default_crew_split" }, { status: 400 });
    }
  }

  const normalizePermissionList = (value: unknown): string[] | null => {
    if (value === null) return null;
    if (!Array.isArray(value)) return null;
    const cleaned = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(cleaned));
  };

  if (payload.permissionsGrant !== undefined) {
    if (payload.permissionsGrant === null) {
      updates["permissionsGrant"] = [];
    } else {
      const normalized = normalizePermissionList(payload.permissionsGrant);
      if (!normalized) {
        return NextResponse.json({ error: "invalid_permissions_grant" }, { status: 400 });
      }
      updates["permissionsGrant"] = normalized;
    }
  }

  if (payload.permissionsDeny !== undefined) {
    if (payload.permissionsDeny === null) {
      updates["permissionsDeny"] = [];
    } else {
      const normalized = normalizePermissionList(payload.permissionsDeny);
      if (!normalized) {
        return NextResponse.json({ error: "invalid_permissions_deny" }, { status: 400 });
      }
      updates["permissionsDeny"] = normalized;
    }
  }

  if (payload.phone !== undefined) {
    if (payload.phone === null) {
      phoneUpdate = { value: null };
    } else if (typeof payload.phone === "string") {
      if (payload.phone.trim().length === 0) {
        phoneUpdate = { value: null };
      } else {
        const normalized = normalizePhoneInput(payload.phone);
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
      let updatedMember: { id: string; name: string; email: string | null; roleId: string | null; active: boolean | null } | null =
        null;

      if (Object.keys(updates).length > 0) {
        updates["updatedAt"] = new Date();
        try {
          const [row] = await tx
            .update(teamMembers)
            .set(updates)
            .where(eq(teamMembers.id, memberId))
            .returning(MEMBER_SELECT);
          updatedMember = row ?? null;
        } catch (error) {
          const code = extractPgCode(error);
          if (code !== "42703" || (updates["defaultCrewSplitBps"] === undefined && updates["permissionsGrant"] === undefined && updates["permissionsDeny"] === undefined)) {
            throw error;
          }

          const fallbackUpdates = { ...updates };
          delete fallbackUpdates["defaultCrewSplitBps"];
          delete fallbackUpdates["permissionsGrant"];
          delete fallbackUpdates["permissionsDeny"];

          if (Object.keys(fallbackUpdates).length === 1 && fallbackUpdates["updatedAt"]) {
            const [row] = await tx
              .select(MEMBER_SELECT)
              .from(teamMembers)
              .where(eq(teamMembers.id, memberId))
              .limit(1);
            updatedMember = row ?? null;
          } else {
            const [row] = await tx
              .update(teamMembers)
              .set(fallbackUpdates)
              .where(eq(teamMembers.id, memberId))
              .returning(MEMBER_SELECT);
            updatedMember = row ?? null;
          }
        }
      } else {
        const [row] = await tx.select(MEMBER_SELECT).from(teamMembers).where(eq(teamMembers.id, memberId)).limit(1);
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
  const actor = getAuditActorFromRequest(request);
  const result = await db.transaction(async (tx) => {
    const [member] = await tx.delete(teamMembers).where(eq(teamMembers.id, memberId)).returning(MEMBER_SELECT);
    if (!member) return { member: null as typeof member | null, clearedDefaultAssignee: false };

    let clearedDefaultAssignee = false;

    // Remove any saved phone mapping for this member.
    const [phoneSetting] = await tx
      .select({ value: policySettings.value })
      .from(policySettings)
      .where(eq(policySettings.key, "team_member_phones"))
      .limit(1);
    const phoneMap = readPhoneMap(phoneSetting?.value);
    if (phoneMap[memberId]) {
      delete phoneMap[memberId];
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

    // If this member was the default lead assignee, clear it so it doesn't point at a deleted member.
    const [salesSetting] = await tx
      .select({ value: policySettings.value })
      .from(policySettings)
      .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
      .limit(1);
    const currentDefault = readDefaultAssignee(salesSetting?.value);
    if (currentDefault === memberId) {
      const nextValue: Record<string, unknown> = isRecord(salesSetting?.value) ? { ...(salesSetting!.value as Record<string, unknown>) } : {};
      delete nextValue["defaultAssigneeMemberId"];
      clearedDefaultAssignee = true;

      await tx
        .insert(policySettings)
        .values({
          key: SALES_SCORECARD_POLICY_KEY,
          value: nextValue,
          updatedBy: actor.id ?? null
        })
        .onConflictDoUpdate({
          target: policySettings.key,
          set: {
            value: nextValue,
            updatedBy: actor.id ?? null,
            updatedAt: new Date()
          }
        });
    }

    return { member, clearedDefaultAssignee };
  });

  if (!result.member) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "team_member.deleted",
    entityType: "team_member",
    entityId: memberId,
    meta: { name: result.member.name, clearedDefaultAssignee: result.clearedDefaultAssignee }
  });

  return NextResponse.json({ ok: true });
}
