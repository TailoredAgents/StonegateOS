import React from "react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  parseOpenAiAdsCampaignReport,
  type OpenAiAdsCampaignReportState,
} from "../lib/openai-ads-reporting-model";
import { OpenAiAdsCampaignReportView } from "./OpenAiAdsCampaignReportView";
import {
  websiteAnalyticsHref,
  type AdvertisingContext,
  type WebsiteAnalyticsRange,
} from "./website-analytics-view";

export async function OpenAiAdsCampaignReport({
  principal,
  rangeDays,
  advertising,
}: {
  principal: TeamRequestPrincipal;
  rangeDays: WebsiteAnalyticsRange;
  advertising: AdvertisingContext;
}): Promise<React.ReactElement> {
  let state: OpenAiAdsCampaignReportState = { kind: "unavailable" };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/openai/ads/reporting?rangeDays=${rangeDays}`,
      { timeoutMs: 12_000 },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const report = parseOpenAiAdsCampaignReport(payload);
      if (report) state = { kind: "ready", report };
    } else if (response.status === 401 || response.status === 403) {
      state = { kind: "forbidden" };
    } else if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error === "openai_ads_reporting_not_configured"
    ) {
      state = { kind: "not_configured" };
    }
  } catch {
    // Campaign reporting failures do not hide conversion delivery or website analytics.
  }
  const refreshHref = `${websiteAnalyticsHref({ rangeDays, advertising, retryToken: new Date().toISOString() })}#chatgpt-campaigns`;
  return (
    <OpenAiAdsCampaignReportView state={state} refreshHref={refreshHref} />
  );
}
