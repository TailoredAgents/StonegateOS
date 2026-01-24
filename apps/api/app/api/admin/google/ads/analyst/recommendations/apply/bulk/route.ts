import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import {
  getDb,
  googleAdsAnalystRecommendationEvents,
  googleAdsAnalystRecommendations
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  applyCustomerNegativeKeyword,
  getGoogleAdsAccessToken,
  getGoogleAdsConfiguredIds
} from "@/lib/google-ads-insights";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const idsRaw = Array.isArray(body["ids"]) ? body["ids"] : [];
  const ids = idsRaw
    .map((value) => asString(value))
    .filter((value): value is string => typeof value === "string");

  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  if (ids.length > 100) {
    return NextResponse.json({ ok: false, error: "too_many_ids" }, { status: 400 });
  }

  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "google_ads_not_configured" }, { status: 400 });
  }

  const accessToken = await getGoogleAdsAccessToken();
  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const db = getDb();

  const recs = await db
    .select({
      id: googleAdsAnalystRecommendations.id,
      reportId: googleAdsAnalystRecommendations.reportId,
      kind: googleAdsAnalystRecommendations.kind,
      status: googleAdsAnalystRecommendations.status,
      payload: googleAdsAnalystRecommendations.payload,
      decidedBy: googleAdsAnalystRecommendations.decidedBy
    })
    .from(googleAdsAnalystRecommendations)
    .where(inArray(googleAdsAnalystRecommendations.id, ids))
    .limit(100);

  const applied: Array<{ id: string; resourceName: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const rec of recs) {
    if (rec.status === "applied") continue;
    if (rec.status !== "approved") {
      failed.push({ id: rec.id, error: `not_approved:${rec.status}` });
      continue;
    }
    if (rec.kind !== "negative_keyword") {
      failed.push({ id: rec.id, error: `unsupported_kind:${rec.kind}` });
      continue;
    }

    const term = asString(rec.payload["term"] ?? rec.payload["keyword"]);
    if (!term) {
      failed.push({ id: rec.id, error: "missing_term" });
      continue;
    }

    try {
      const result = await applyCustomerNegativeKeyword({
        customerId,
        accessToken,
        term
      });

      await db
        .update(googleAdsAnalystRecommendations)
        .set({
          status: "applied",
          appliedAt: now,
          updatedAt: now,
          decidedBy: rec.decidedBy ?? actor.id ?? null
        })
        .where(inArray(googleAdsAnalystRecommendations.id, [rec.id]));

      await db.insert(googleAdsAnalystRecommendationEvents).values({
        recommendationId: rec.id,
        reportId: rec.reportId,
        kind: rec.kind,
        fromStatus: rec.status,
        toStatus: "applied",
        note: `Applied customer negative keyword (${result.matchType}) "${result.term}" (${result.resourceName})`.slice(
          0,
          800
        ),
        actorMemberId: actor.id ?? null,
        actorSource: "ui"
      });

      applied.push({ id: rec.id, resourceName: result.resourceName });
    } catch (error) {
      failed.push({ id: rec.id, error: (error as Error)?.message ?? "apply_failed" });
      await db.insert(googleAdsAnalystRecommendationEvents).values({
        recommendationId: rec.id,
        reportId: rec.reportId,
        kind: rec.kind,
        fromStatus: rec.status,
        toStatus: rec.status,
        note: `Apply failed: ${(error as Error)?.message ?? "unknown_error"}`.slice(0, 800),
        actorMemberId: actor.id ?? null,
        actorSource: "ui"
      });
    }
  }

  await recordAuditEvent({
    actor,
    action: "marketing.google_ads_recommendations.bulk_apply",
    entityType: "google_ads_analyst_recommendation",
    entityId: applied[0]?.id ?? failed[0]?.id ?? "bulk",
    meta: { applied: applied.length, failed: failed.length }
  });

  return NextResponse.json({ ok: true, applied, failed });
}

