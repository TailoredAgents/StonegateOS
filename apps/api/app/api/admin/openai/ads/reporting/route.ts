import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import {
  getOpenAiAdsReport,
  OpenAiAdsReportingError,
} from "@/lib/openai-ads-reporting";
import {
  buildWebsiteAnalyticsWindow,
  parseWebsiteAnalyticsRangeDays,
} from "@/lib/web-analytics-reporting";

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requirePermission(request, "marketing.read");
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  const rangeDays = parseWebsiteAnalyticsRangeDays(
    new URL(request.url).searchParams.get("rangeDays"),
  );
  if (rangeDays === null)
    return NextResponse.json(
      { ok: false, error: "invalid_range_days" },
      { status: 400, headers },
    );
  try {
    const { timeframe } = buildWebsiteAnalyticsWindow(rangeDays);
    const report = await getOpenAiAdsReport(timeframe);
    return NextResponse.json(report, { headers });
  } catch (error) {
    const code =
      error instanceof OpenAiAdsReportingError
        ? error.code
        : "openai_ads_reporting_unavailable";
    return NextResponse.json(
      {
        ok: false,
        configured: code !== "openai_ads_reporting_not_configured",
        error: code,
      },
      {
        status: error instanceof OpenAiAdsReportingError ? error.status : 503,
        headers,
      },
    );
  }
}
