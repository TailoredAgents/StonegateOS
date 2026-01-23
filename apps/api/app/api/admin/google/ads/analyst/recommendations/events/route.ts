import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, googleAdsAnalystRecommendationEvents, googleAdsAnalystReports, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../../web/admin";

function asString(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(Math.floor(parsed), 1), 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const reportIdParam = asString(url.searchParams.get("reportId"));
  const recommendationIdParam = asString(url.searchParams.get("recommendationId"));
  const limit = parseLimit(url.searchParams.get("limit"));

  const db = getDb();
  let reportId = reportIdParam;
  if (!reportId && !recommendationIdParam) {
    reportId = await db
      .select({ id: googleAdsAnalystReports.id })
      .from(googleAdsAnalystReports)
      .orderBy(desc(googleAdsAnalystReports.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
  }

  if (!reportId && !recommendationIdParam) {
    return NextResponse.json({ ok: true, reportId: null, recommendationId: null, items: [] });
  }

  const baseQuery = db
    .select({
      id: googleAdsAnalystRecommendationEvents.id,
      reportId: googleAdsAnalystRecommendationEvents.reportId,
      recommendationId: googleAdsAnalystRecommendationEvents.recommendationId,
      kind: googleAdsAnalystRecommendationEvents.kind,
      fromStatus: googleAdsAnalystRecommendationEvents.fromStatus,
      toStatus: googleAdsAnalystRecommendationEvents.toStatus,
      note: googleAdsAnalystRecommendationEvents.note,
      actorMemberId: googleAdsAnalystRecommendationEvents.actorMemberId,
      actorName: teamMembers.name,
      actorSource: googleAdsAnalystRecommendationEvents.actorSource,
      createdAt: googleAdsAnalystRecommendationEvents.createdAt
    })
    .from(googleAdsAnalystRecommendationEvents)
    .leftJoin(teamMembers, eq(teamMembers.id, googleAdsAnalystRecommendationEvents.actorMemberId))
    .orderBy(desc(googleAdsAnalystRecommendationEvents.createdAt))
    .limit(limit);

  const rows = recommendationIdParam
    ? await baseQuery.where(eq(googleAdsAnalystRecommendationEvents.recommendationId, recommendationIdParam))
    : await baseQuery.where(eq(googleAdsAnalystRecommendationEvents.reportId, reportId as string));

  return NextResponse.json({
    ok: true,
    reportId: reportId ?? null,
    recommendationId: recommendationIdParam ?? null,
    items: rows.map((row) => ({
      id: row.id,
      reportId: row.reportId,
      recommendationId: row.recommendationId,
      kind: row.kind,
      fromStatus: row.fromStatus ?? null,
      toStatus: row.toStatus,
      note: row.note ?? null,
      actorMemberId: row.actorMemberId ?? null,
      actorName: row.actorName ?? null,
      actorSource: row.actorSource,
      createdAt: row.createdAt.toISOString()
    }))
  });
}
