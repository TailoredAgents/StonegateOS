import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { SALES_SCORECARD_POLICY_KEY } from "@/lib/sales-scorecard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const nowIso = new Date().toISOString();

  const [existing] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
    .limit(1);

  const nextValue: Record<string, unknown> = isRecord(existing?.value) ? { ...existing.value } : {};
  nextValue["trackingStartAt"] = nowIso;

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
    action: "sales.reset",
    entityType: "policy_setting",
    entityId: SALES_SCORECARD_POLICY_KEY,
    meta: { trackingStartAt: nowIso }
  });

  return NextResponse.json({ ok: true, trackingStartAt: nowIso });
}

