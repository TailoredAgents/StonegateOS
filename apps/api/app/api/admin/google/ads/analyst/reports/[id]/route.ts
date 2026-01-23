import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, googleAdsAnalystReports, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../../web/admin";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const request = _request;
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const db = getDb();
  const row = await db
    .select({
      id: googleAdsAnalystReports.id,
      rangeDays: googleAdsAnalystReports.rangeDays,
      since: googleAdsAnalystReports.since,
      until: googleAdsAnalystReports.until,
      callWeight: googleAdsAnalystReports.callWeight,
      bookingWeight: googleAdsAnalystReports.bookingWeight,
      report: googleAdsAnalystReports.report,
      createdBy: googleAdsAnalystReports.createdBy,
      createdByName: teamMembers.name,
      createdAt: googleAdsAnalystReports.createdAt
    })
    .from(googleAdsAnalystReports)
    .leftJoin(teamMembers, eq(teamMembers.id, googleAdsAnalystReports.createdBy))
    .where(eq(googleAdsAnalystReports.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    report: {
      id: row.id,
      rangeDays: row.rangeDays,
      since: row.since,
      until: row.until,
      callWeight: String(row.callWeight),
      bookingWeight: String(row.bookingWeight),
      report: row.report,
      createdBy: row.createdBy ?? null,
      createdByName: row.createdByName ?? null,
      createdAt: row.createdAt.toISOString()
    }
  });
}
