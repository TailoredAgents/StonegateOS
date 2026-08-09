import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, gte, sql } from "drizzle-orm";
import { getDb, webEventCountsDaily } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  buildWebsiteAnalyticsWindow,
  parseWebsiteAnalyticsRangeDays,
  WEBSITE_ANALYTICS_RANGE_DAYS,
} from "@/lib/web-analytics-reporting";

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requirePermission(request, "marketing.read");
  if (denied) return denied;

  const rangeDays = parseWebsiteAnalyticsRangeDays(
    request.nextUrl.searchParams.get("rangeDays"),
  );
  if (rangeDays === null) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_range",
        allowedRangeDays: WEBSITE_ANALYTICS_RANGE_DAYS,
      },
      { status: 422 },
    );
  }

  let reportingWindow: ReturnType<typeof buildWebsiteAnalyticsWindow>;
  try {
    reportingWindow = buildWebsiteAnalyticsWindow(rangeDays);
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_time" },
      { status: 500 },
    );
  }
  const { timeframe } = reportingWindow;
  const { since } = timeframe;

  const db = getDb();
  const rows = await db
    .select({
      event: webEventCountsDaily.event,
      key: webEventCountsDaily.key,
      path: webEventCountsDaily.path,
      count: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(
        Number,
      ),
    })
    .from(webEventCountsDaily)
    .where(
      and(
        gte(webEventCountsDaily.dateStart, since),
        sql`${webEventCountsDaily.event} like '%_fail'`,
      ),
    )
    .groupBy(
      webEventCountsDaily.event,
      webEventCountsDaily.key,
      webEventCountsDaily.path,
    )
    .orderBy(desc(sql`sum(${webEventCountsDaily.count})`))
    .limit(40);

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    timeframe,
    items: rows.map((row) => ({
      event: row.event,
      key: row.key || null,
      path: row.path,
      count: row.count,
    })),
  });
}
