import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampInt(value: unknown, { min, max }: { min: number; max: number }): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  return Math.min(max, Math.max(min, rounded));
}

function coerceOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

const POLICY_KEY = "sales_autopilot" as const;

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const policy = await getSalesAutopilotPolicy(db);
  return NextResponse.json({ ok: true, policy });
}

export async function PATCH(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const next: Record<string, unknown> = {};

  if ("enabled" in payload) {
    const raw = payload["enabled"];
    if (typeof raw === "boolean") next["enabled"] = raw;
    else if (typeof raw === "string") next["enabled"] = raw === "true" || raw === "on";
  }

  const autoSendAfterMinutes = clampInt(payload["autoSendAfterMinutes"], { min: 15, max: 120 });
  if (autoSendAfterMinutes !== null) next["autoSendAfterMinutes"] = autoSendAfterMinutes;

  const activityWindowMinutes = clampInt(payload["activityWindowMinutes"], { min: 1, max: 120 });
  if (activityWindowMinutes !== null) next["activityWindowMinutes"] = activityWindowMinutes;

  const retryDelayMinutes = clampInt(payload["retryDelayMinutes"], { min: 1, max: 60 });
  if (retryDelayMinutes !== null) next["retryDelayMinutes"] = retryDelayMinutes;

  const dmSmsFallbackAfterMinutes = clampInt(payload["dmSmsFallbackAfterMinutes"], { min: 15, max: 24 * 60 });
  if (dmSmsFallbackAfterMinutes !== null) next["dmSmsFallbackAfterMinutes"] = dmSmsFallbackAfterMinutes;

  const dmMinSilenceBeforeSmsMinutes = clampInt(payload["dmMinSilenceBeforeSmsMinutes"], { min: 5, max: 12 * 60 });
  if (dmMinSilenceBeforeSmsMinutes !== null) next["dmMinSilenceBeforeSmsMinutes"] = dmMinSilenceBeforeSmsMinutes;

  const agentDisplayName = coerceOptionalString(payload["agentDisplayName"]);
  if (agentDisplayName !== null) next["agentDisplayName"] = agentDisplayName;

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [existing] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, POLICY_KEY))
    .limit(1);
  const merged: Record<string, unknown> = isRecord(existing?.value) ? { ...(existing!.value as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(next)) {
    merged[key] = value;
  }

  await db
    .insert(policySettings)
    .values({
      key: POLICY_KEY,
      value: merged,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: policySettings.key,
      set: {
        value: merged,
        updatedBy: actor.id ?? null,
        updatedAt: new Date()
      }
    });

  await recordAuditEvent({
    actor,
    action: "sales.autopilot.policy.updated",
    entityType: "policy_setting",
    entityId: POLICY_KEY,
    meta: { updatedKeys: Object.keys(next) }
  });

  const policy = await getSalesAutopilotPolicy(db);
  return NextResponse.json({ ok: true, policy });
}

