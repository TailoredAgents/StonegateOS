import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, googleAdsAnalystReports, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";

function parseLimit(value: string | null): number {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(Math.floor(parsed), 1), 200);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));

  const db = getDb();
  const rows = await db
    .select({
      id: googleAdsAnalystReports.id,
      rangeDays: googleAdsAnalystReports.rangeDays,
      since: googleAdsAnalystReports.since,
      until: googleAdsAnalystReports.until,
      callWeight: googleAdsAnalystReports.callWeight,
      bookingWeight: googleAdsAnalystReports.bookingWeight,
      createdBy: googleAdsAnalystReports.createdBy,
      createdByName: teamMembers.name,
      createdAt: googleAdsAnalystReports.createdAt
    })
    .from(googleAdsAnalystReports)
    .leftJoin(teamMembers, eq(teamMembers.id, googleAdsAnalystReports.createdBy))
    .orderBy(desc(googleAdsAnalystReports.createdAt))
    .limit(limit);

  return NextResponse.json({
    ok: true,
    items: rows.map((row) => ({
      id: row.id,
      rangeDays: row.rangeDays,
      since: row.since,
      until: row.until,
      callWeight: String(row.callWeight),
      bookingWeight: String(row.bookingWeight),
      createdBy: row.createdBy,
      createdByName: row.createdByName ?? null,
      createdAt: row.createdAt.toISOString()
    }))
  });
}
