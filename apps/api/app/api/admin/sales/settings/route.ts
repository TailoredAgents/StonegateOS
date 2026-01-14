import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, policySettings, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { SALES_SCORECARD_POLICY_KEY } from "@/lib/sales-scorecard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
    .limit(1);

  const stored = isRecord(row?.value) ? (row!.value as Record<string, unknown>) : {};
  const defaultAssigneeMemberIdRaw = typeof stored["defaultAssigneeMemberId"] === "string" ? stored["defaultAssigneeMemberId"].trim() : "";
  const defaultAssigneeMemberId = defaultAssigneeMemberIdRaw.length > 0 ? defaultAssigneeMemberIdRaw : null;

  return NextResponse.json({
    ok: true,
    defaultAssigneeMemberId
  });
}

export async function PATCH(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const raw = record["defaultAssigneeMemberId"];
  let nextId: string | null = null;
  if (raw === null) {
    nextId = null;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      nextId = null;
    } else if (!isUuid(trimmed)) {
      return NextResponse.json({ error: "invalid_member_id" }, { status: 400 });
    } else {
      nextId = trimmed;
    }
  } else {
    return NextResponse.json({ error: "invalid_member_id" }, { status: 400 });
  }

  const db = getDb();
  if (nextId) {
    const [member] = await db.select({ id: teamMembers.id }).from(teamMembers).where(eq(teamMembers.id, nextId)).limit(1);
    if (!member?.id) {
      return NextResponse.json({ error: "member_not_found" }, { status: 404 });
    }
  }

  const actor = getAuditActorFromRequest(request);
  const [existing] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
    .limit(1);

  const nextValue: Record<string, unknown> = isRecord(existing?.value) ? { ...(existing!.value as Record<string, unknown>) } : {};
  if (nextId) {
    nextValue["defaultAssigneeMemberId"] = nextId;
  } else {
    delete nextValue["defaultAssigneeMemberId"];
  }

  await db
    .insert(policySettings)
    .values({
      key: SALES_SCORECARD_POLICY_KEY,
      value: nextValue,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: policySettings.key,
      set: {
        value: nextValue,
        updatedBy: actor.id ?? null,
        updatedAt: new Date()
      }
    });

  await recordAuditEvent({
    actor,
    action: "sales.default_assignee.updated",
    entityType: "policy_setting",
    entityId: SALES_SCORECARD_POLICY_KEY,
    meta: { defaultAssigneeMemberId: nextId }
  });

  return NextResponse.json({ ok: true, defaultAssigneeMemberId: nextId });
}
