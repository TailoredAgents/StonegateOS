import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, googleAdsAnalystReports, providerHealth } from "@/db";
import { getGoogleAdsAnalystPolicy } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const policy = await getGoogleAdsAnalystPolicy(db);

  const [healthRow, latest] = await Promise.all([
    db
      .select({
        lastSuccessAt: providerHealth.lastSuccessAt,
        lastFailureAt: providerHealth.lastFailureAt,
        lastFailureDetail: providerHealth.lastFailureDetail
      })
      .from(providerHealth)
      .where(eq(providerHealth.provider, "google_ads_analyst"))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: googleAdsAnalystReports.id,
        rangeDays: googleAdsAnalystReports.rangeDays,
        since: googleAdsAnalystReports.since,
        until: googleAdsAnalystReports.until,
        callWeight: googleAdsAnalystReports.callWeight,
        bookingWeight: googleAdsAnalystReports.bookingWeight,
        report: googleAdsAnalystReports.report,
        createdAt: googleAdsAnalystReports.createdAt
      })
      .from(googleAdsAnalystReports)
      .orderBy(desc(googleAdsAnalystReports.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null)
  ]);

  return NextResponse.json({
    ok: true,
    policy,
    health: {
      lastSuccessAt: healthRow?.lastSuccessAt ? healthRow.lastSuccessAt.toISOString() : null,
      lastFailureAt: healthRow?.lastFailureAt ? healthRow.lastFailureAt.toISOString() : null,
      lastFailureDetail: healthRow?.lastFailureDetail ?? null
    },
    latest: latest
      ? {
          id: latest.id,
          rangeDays: latest.rangeDays,
          since: latest.since,
          until: latest.until,
          callWeight: String(latest.callWeight),
          bookingWeight: String(latest.bookingWeight),
          report: latest.report,
          createdAt: latest.createdAt.toISOString()
        }
      : null
  });
}

