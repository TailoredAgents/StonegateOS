import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, webVitals } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

function parseRangeDays(request: NextRequest): number {
  const rangeDaysRaw = request.nextUrl.searchParams.get("rangeDays");
  const parsed = rangeDaysRaw ? Number(rangeDaysRaw) : NaN;
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const rangeDays = parseRangeDays(request);
  const cutoff = DateTime.now().minus({ days: rangeDays }).toJSDate();

  const db = getDb();
  const rows = await db
    .select({
      path: webVitals.path,
      metric: webVitals.metric,
      device: webVitals.device,
      samples: sql<number>`count(*)`.mapWith(Number),
      p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`.mapWith(Number)
    })
    .from(webVitals)
    .where(and(gte(webVitals.createdAt, cutoff), sql`${webVitals.path} in ('/','/book')`))
    .groupBy(webVitals.path, webVitals.metric, webVitals.device);

  return NextResponse.json({
    ok: true,
    rangeDays,
    since: cutoff.toISOString(),
    items: rows
  });
}
