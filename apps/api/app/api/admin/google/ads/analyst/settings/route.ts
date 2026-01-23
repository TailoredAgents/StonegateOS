import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, policySettings } from "@/db";
import { getGoogleAdsAnalystPolicy, DEFAULT_GOOGLE_ADS_ANALYST_POLICY } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const policy = await getGoogleAdsAnalystPolicy(db);
  return NextResponse.json({ ok: true, policy });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const db = getDb();
  const current = await getGoogleAdsAnalystPolicy(db);

  const next = {
    enabled: typeof payload["enabled"] === "boolean" ? (payload["enabled"] as boolean) : current.enabled,
    autonomous:
      typeof payload["autonomous"] === "boolean" ? (payload["autonomous"] as boolean) : current.autonomous,
    callWeight: toNumber(payload["callWeight"]) ?? current.callWeight,
    bookingWeight: toNumber(payload["bookingWeight"]) ?? current.bookingWeight,
    minSpendForNegatives: toNumber(payload["minSpendForNegatives"]) ?? current.minSpendForNegatives,
    minClicksForNegatives: toNumber(payload["minClicksForNegatives"]) ?? current.minClicksForNegatives
  };

  // Sanitize weights and thresholds.
  next.callWeight = Math.max(0, Math.min(1, next.callWeight));
  next.bookingWeight = Math.max(0, Math.min(1, next.bookingWeight));
  next.minSpendForNegatives = Math.max(0, Math.min(1000, Math.round(next.minSpendForNegatives)));
  next.minClicksForNegatives = Math.max(0, Math.min(1000, Math.round(next.minClicksForNegatives)));

  if (next.callWeight + next.bookingWeight <= 0) {
    next.callWeight = DEFAULT_GOOGLE_ADS_ANALYST_POLICY.callWeight;
    next.bookingWeight = DEFAULT_GOOGLE_ADS_ANALYST_POLICY.bookingWeight;
  }

  const actor = getAuditActorFromRequest(request);

  await db
    .insert(policySettings)
    .values({
      key: "google_ads_analyst",
      value: next as unknown as Record<string, unknown>,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: policySettings.key,
      set: {
        value: next as unknown as Record<string, unknown>,
        updatedBy: actor.id ?? null,
        updatedAt: new Date()
      }
    });

  await recordAuditEvent({
    actor,
    action: "policy.update",
    entityType: "policy_setting",
    entityId: "google_ads_analyst",
    meta: { key: "google_ads_analyst" }
  });

  return NextResponse.json({ ok: true, policy: next });
}

