import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, googleAdsAnalystRecommendations, googleAdsAnalystReports } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isAllowedStatus(status: string): status is "proposed" | "approved" | "ignored" | "applied" {
  return status === "proposed" || status === "approved" || status === "ignored" || status === "applied";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const reportIdParam = asString(url.searchParams.get("reportId"));

  const db = getDb();
  const reportId =
    reportIdParam ??
    (await db
      .select({ id: googleAdsAnalystReports.id })
      .from(googleAdsAnalystReports)
      .orderBy(desc(googleAdsAnalystReports.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null));

  if (!reportId) {
    return NextResponse.json({ ok: true, reportId: null, items: [] });
  }

  const items = await db
    .select({
      id: googleAdsAnalystRecommendations.id,
      kind: googleAdsAnalystRecommendations.kind,
      status: googleAdsAnalystRecommendations.status,
      payload: googleAdsAnalystRecommendations.payload,
      decidedBy: googleAdsAnalystRecommendations.decidedBy,
      decidedAt: googleAdsAnalystRecommendations.decidedAt,
      appliedAt: googleAdsAnalystRecommendations.appliedAt,
      createdAt: googleAdsAnalystRecommendations.createdAt
    })
    .from(googleAdsAnalystRecommendations)
    .where(eq(googleAdsAnalystRecommendations.reportId, reportId))
    .orderBy(desc(googleAdsAnalystRecommendations.createdAt))
    .limit(200);

  return NextResponse.json({
    ok: true,
    reportId,
    items: items.map((row) => ({
      ...row,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString()
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = asString(payload["id"]);
  const status = asString(payload["status"]);

  if (!id || !status || !isAllowedStatus(status)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  const db = getDb();
  const [updated] = await db
    .update(googleAdsAnalystRecommendations)
    .set({
      status,
      decidedBy: actor.id ?? null,
      decidedAt: status === "proposed" ? null : now,
      appliedAt: status === "applied" ? now : null,
      updatedAt: now
    })
    .where(eq(googleAdsAnalystRecommendations.id, id))
    .returning({ id: googleAdsAnalystRecommendations.id, kind: googleAdsAnalystRecommendations.kind });

  if (!updated?.id) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "marketing.google_ads_recommendation.update",
    entityType: "google_ads_analyst_recommendation",
    entityId: updated.id,
    meta: { status, kind: updated.kind }
  });

  return NextResponse.json({ ok: true, id: updated.id, status });
}
