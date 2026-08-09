import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, sql } from "drizzle-orm";
import { getDb, webVitals } from "@/db";
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
  const { timeframe, startAt: cutoff } = reportingWindow;

  const db = getDb();
  const rows = await db
    .select({
      path: webVitals.path,
      metric: webVitals.metric,
      device: webVitals.device,
      samples: sql<number>`count(*)`.mapWith(Number),
      p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`.mapWith(
        Number,
      ),
    })
    .from(webVitals)
    .where(
      and(
        gte(webVitals.createdAt, cutoff),
        sql`${webVitals.path} in ('/','/book','/bookbrush','/bookdemo')`,
      ),
    )
    .groupBy(webVitals.path, webVitals.metric, webVitals.device);

  return NextResponse.json({
    ok: true,
    rangeDays,
    since: timeframe.since,
    timeframe,
    items: rows,
  });
}
