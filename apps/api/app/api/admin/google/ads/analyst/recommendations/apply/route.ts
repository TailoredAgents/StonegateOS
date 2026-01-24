import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, googleAdsAnalystRecommendationEvents, googleAdsAnalystRecommendations } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../../web/admin";
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

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = asString(payload["id"]);
  if (!id) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  const recommendation = await db
    .select({
      id: googleAdsAnalystRecommendations.id,
      reportId: googleAdsAnalystRecommendations.reportId,
      kind: googleAdsAnalystRecommendations.kind,
      status: googleAdsAnalystRecommendations.status,
      payload: googleAdsAnalystRecommendations.payload,
      decidedBy: googleAdsAnalystRecommendations.decidedBy
    })
    .from(googleAdsAnalystRecommendations)
    .where(eq(googleAdsAnalystRecommendations.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!recommendation) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (recommendation.status === "applied") {
    return NextResponse.json({ ok: true, id: recommendation.id, status: "applied" });
  }

  if (recommendation.status !== "approved") {
    return NextResponse.json(
      { ok: false, error: "not_approved", status: recommendation.status },
      { status: 400 }
    );
  }

  if (recommendation.kind !== "negative_keyword") {
    return NextResponse.json(
      { ok: false, error: "unsupported_kind", kind: recommendation.kind },
      { status: 400 }
    );
  }

  const term = asString(recommendation.payload["term"] ?? recommendation.payload["keyword"]);
  if (!term) {
    return NextResponse.json({ ok: false, error: "missing_term" }, { status: 400 });
  }

  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "google_ads_not_configured" }, { status: 400 });
  }

  const accessToken = await getGoogleAdsAccessToken();
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
      decidedBy: recommendation.decidedBy ?? actor.id ?? null
    })
    .where(eq(googleAdsAnalystRecommendations.id, recommendation.id));

  await db.insert(googleAdsAnalystRecommendationEvents).values({
    recommendationId: recommendation.id,
    reportId: recommendation.reportId,
    kind: recommendation.kind,
    fromStatus: recommendation.status,
    toStatus: "applied",
    note: `Applied customer negative keyword (${result.matchType}) "${result.term}" (${result.resourceName})`.slice(
      0,
      800
    ),
    actorMemberId: actor.id ?? null,
    actorSource: "ui"
  });

  await recordAuditEvent({
    actor,
    action: "marketing.google_ads_recommendation.apply",
    entityType: "google_ads_analyst_recommendation",
    entityId: recommendation.id,
    meta: {
      kind: recommendation.kind,
      term: result.term,
      matchType: result.matchType,
      resourceName: result.resourceName
    }
  });

  return NextResponse.json({
    ok: true,
    id: recommendation.id,
    status: "applied",
    resourceName: result.resourceName
  });
}

