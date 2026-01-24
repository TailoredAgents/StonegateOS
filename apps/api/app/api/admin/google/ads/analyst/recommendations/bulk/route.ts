import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import {
  getDb,
  googleAdsAnalystRecommendationEvents,
  googleAdsAnalystRecommendations
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isAllowedStatus(status: string): status is "proposed" | "approved" | "ignored" {
  return status === "proposed" || status === "approved" || status === "ignored";
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const status = asString(body["status"]);
  const note = asString(body["note"]);
  const idsRaw = Array.isArray(body["ids"]) ? body["ids"] : [];
  const ids = idsRaw
    .map((value) => asString(value))
    .filter((value): value is string => typeof value === "string");

  if (!status || !isAllowedStatus(status) || ids.length === 0) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  if (ids.length > 200) {
    return NextResponse.json({ ok: false, error: "too_many_ids" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const db = getDb();

  const existing = await db
    .select({
      id: googleAdsAnalystRecommendations.id,
      reportId: googleAdsAnalystRecommendations.reportId,
      kind: googleAdsAnalystRecommendations.kind,
      status: googleAdsAnalystRecommendations.status
    })
    .from(googleAdsAnalystRecommendations)
    .where(inArray(googleAdsAnalystRecommendations.id, ids))
    .limit(200);

  if (existing.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, skipped: ids.length });
  }

  const toUpdate = existing.filter((row) => row.status !== status);
  if (toUpdate.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, skipped: existing.length });
  }

  const updateIds = toUpdate.map((row) => row.id);

  await db
    .update(googleAdsAnalystRecommendations)
    .set({
      status,
      decidedBy: status === "proposed" ? null : actor.id ?? null,
      decidedAt: status === "proposed" ? null : now,
      appliedAt: null,
      updatedAt: now
    })
    .where(inArray(googleAdsAnalystRecommendations.id, updateIds));

  await db.insert(googleAdsAnalystRecommendationEvents).values(
    toUpdate.map((row) => ({
      recommendationId: row.id,
      reportId: row.reportId,
      kind: row.kind,
      fromStatus: row.status,
      toStatus: status,
      note: note ? note.slice(0, 800) : null,
      actorMemberId: actor.id ?? null,
      actorSource: "ui"
    }))
  );

  await recordAuditEvent({
    actor,
    action: "marketing.google_ads_recommendations.bulk_update",
    entityType: "google_ads_analyst_recommendation",
    entityId: toUpdate[0]?.id ?? "bulk",
    meta: { status, updated: updateIds.length }
  });

  return NextResponse.json({ ok: true, updated: updateIds.length, skipped: existing.length - updateIds.length });
}

