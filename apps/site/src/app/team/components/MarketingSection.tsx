import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  runGoogleAdsAnalystAction,
  runGoogleAdsSyncAction,
  saveGoogleAdsAnalystSettingsAction,
  updateGoogleAdsAnalystRecommendationAction
} from "../actions";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE } from "./team-ui";
import { GoogleAdsRecommendationsPanel } from "./GoogleAdsRecommendationsPanel";

type GoogleAdsStatusPayload = {
  ok: true;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
  lastFetchedAt: string | null;
  lastFetchedDate: string | null;
};

type GoogleAdsSummaryPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  totals: {
    impressions: number;
    clicks: number;
    cost: string;
    conversions: string;
    conversionValue: string;
    days: number;
  };
  topCampaigns: Array<{
    campaignId: string;
    campaignName: string | null;
    clicks: number;
    cost: string;
    conversions: string;
  }>;
  topSearchTerms: Array<{
    searchTerm: string;
    campaignId: string;
    clicks: number;
    cost: string;
    conversions: string;
  }>;
};

type GoogleAdsAnalystPolicy = {
  enabled: boolean;
  autonomous: boolean;
  callWeight: number;
  bookingWeight: number;
  minSpendForNegatives: number;
  minClicksForNegatives: number;
};

type GoogleAdsAnalystStatusPayload = {
  ok: true;
  policy: GoogleAdsAnalystPolicy;
  health: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureDetail: string | null;
  };
  latest: {
    id: string;
    rangeDays: number;
    since: string;
    until: string;
    callWeight: string;
    bookingWeight: string;
    report: {
      summary: string;
      top_actions: string[];
      negatives_to_review: string[];
      pause_candidates_to_review: string[];
      notes: string;
    };
    createdAt: string;
  } | null;
};

type GoogleAdsAnalystRecommendationStatus = "proposed" | "approved" | "ignored" | "applied";

type GoogleAdsAnalystRecommendation = {
  id: string;
  kind: string;
  status: GoogleAdsAnalystRecommendationStatus;
  payload: Record<string, unknown>;
  decidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
};

type GoogleAdsAnalystRecommendationsPayload = {
  ok: true;
  reportId: string | null;
  items: GoogleAdsAnalystRecommendation[];
};

type GoogleAdsAnalystReportListPayload = {
  ok: true;
  items: Array<{
    id: string;
    rangeDays: number;
    since: string;
    until: string;
    callWeight: string;
    bookingWeight: string;
    createdBy: string | null;
    createdByName: string | null;
    createdAt: string;
  }>;
};

type GoogleAdsAnalystRecommendationEventsPayload = {
  ok: true;
  reportId: string | null;
  recommendationId: string | null;
  items: Array<{
    id: string;
    reportId: string;
    recommendationId: string;
    kind: string;
    fromStatus: string | null;
    toStatus: string;
    note: string | null;
    actorMemberId: string | null;
    actorName: string | null;
    actorSource: string;
    createdAt: string;
  }>;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function fmtMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function hasActiveFailure(input: { lastFailureAt: string | null; lastSuccessAt: string | null }): boolean {
  if (!input.lastFailureAt) return false;
  if (!input.lastSuccessAt) return true;
  const failureAt = new Date(input.lastFailureAt).getTime();
  const successAt = new Date(input.lastSuccessAt).getTime();
  if (Number.isNaN(failureAt) || Number.isNaN(successAt)) return true;
  return failureAt >= successAt;
}

function normalizeWeight(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export async function MarketingSection(props: { reportId?: string }): Promise<React.ReactElement> {
  let status: GoogleAdsStatusPayload | null = null;
  let summary: GoogleAdsSummaryPayload | null = null;
  let analyst: GoogleAdsAnalystStatusPayload | null = null;
  let reports: GoogleAdsAnalystReportListPayload | null = null;
  let recs: GoogleAdsAnalystRecommendationsPayload | null = null;
  let events: GoogleAdsAnalystRecommendationEventsPayload | null = null;
  let selectedReport: GoogleAdsAnalystStatusPayload["latest"] | null = null;
  let error: string | null = null;

  try {
    const [statusRes, summaryRes, analystRes, reportsRes] = await Promise.all([
      callAdminApi("/api/admin/google/ads/status"),
      callAdminApi("/api/admin/google/ads/summary?rangeDays=7"),
      callAdminApi("/api/admin/google/ads/analyst/status"),
      callAdminApi("/api/admin/google/ads/analyst/reports?limit=30")
    ]);

    if (statusRes.ok) {
      status = (await statusRes.json()) as GoogleAdsStatusPayload;
    } else {
      error = `Google Ads status unavailable (HTTP ${statusRes.status})`;
    }

    if (summaryRes.ok) {
      summary = (await summaryRes.json()) as GoogleAdsSummaryPayload;
    }

    if (analystRes.ok) {
      analyst = (await analystRes.json()) as GoogleAdsAnalystStatusPayload;
    }

    if (reportsRes.ok) {
      reports = (await reportsRes.json()) as GoogleAdsAnalystReportListPayload;
    }

    const selectedReportIdRaw = typeof props.reportId === "string" ? props.reportId.trim() : "";
    const selectedReportId =
      selectedReportIdRaw.length > 0
        ? selectedReportIdRaw
        : analyst?.latest?.id ?? reports?.items?.[0]?.id ?? null;

    if (selectedReportId) {
      selectedReport = analyst?.latest?.id === selectedReportId ? analyst.latest : null;
      if (!selectedReport) {
        const reportDetailRes = await callAdminApi(
          `/api/admin/google/ads/analyst/reports/${encodeURIComponent(selectedReportId)}`
        );
        if (reportDetailRes.ok) {
          const detail = (await reportDetailRes.json().catch(() => null)) as any;
          if (detail?.ok && detail?.report) {
            selectedReport = {
              id: String(detail.report.id),
              rangeDays: Number(detail.report.rangeDays),
              since: String(detail.report.since),
              until: String(detail.report.until),
              callWeight: String(detail.report.callWeight),
              bookingWeight: String(detail.report.bookingWeight),
              report: detail.report.report as any,
              createdAt: String(detail.report.createdAt)
            };
          }
        }
      }

      const [recsRes, eventsRes] = await Promise.all([
        callAdminApi(`/api/admin/google/ads/analyst/recommendations?reportId=${encodeURIComponent(selectedReportId)}`),
        callAdminApi(
          `/api/admin/google/ads/analyst/recommendations/events?reportId=${encodeURIComponent(selectedReportId)}`
        )
      ]);

      if (recsRes.ok) {
        recs = (await recsRes.json()) as GoogleAdsAnalystRecommendationsPayload;
      }
      if (eventsRes.ok) {
        events = (await eventsRes.json()) as GoogleAdsAnalystRecommendationEventsPayload;
      }
    } else {
      recs = { ok: true, reportId: null, items: [] };
      events = { ok: true, reportId: null, recommendationId: null, items: [] };
    }
  } catch {
    error = "Google Ads status unavailable.";
  }

  const configured = status?.configured ?? false;
  const lastSyncAt = status?.lastFetchedAt ?? status?.lastSuccessAt ?? null;

  const adsFailure =
    status && hasActiveFailure({ lastFailureAt: status.lastFailureAt, lastSuccessAt: status.lastSuccessAt });

  const analystFailure =
    analyst?.health &&
    hasActiveFailure({ lastFailureAt: analyst.health.lastFailureAt, lastSuccessAt: analyst.health.lastSuccessAt });

  const policy = analyst?.policy ?? null;
  const callWeight = normalizeWeight(policy?.callWeight ?? NaN, 0.7);
  const bookingWeight = normalizeWeight(policy?.bookingWeight ?? NaN, 0.3);
  const weightSum = callWeight + bookingWeight;
  const safeCallWeight = weightSum > 0 ? callWeight / weightSum : 0.7;
  const safeBookingWeight = weightSum > 0 ? bookingWeight / weightSum : 0.3;

  const recommendations = recs?.items ?? [];
  const selectedReportId = recs?.reportId ?? null;
  const reportHistory = reports?.items ?? [];
  const changeLog = events?.items ?? [];
  const activeReport = selectedReport ?? analyst?.latest ?? null;
  const approvedNegatives = recommendations
    .filter((item) => item.kind === "negative_keyword" && item.status === "approved")
    .map((item) => String(item.payload["term"] ?? "").trim())
    .filter((term) => term.length > 0);

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Marketing</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Google Ads sync and AI analysis. Default behavior is safe: the CRM never auto-applies changes to Google Ads.
          You can optionally enable auto-run to refresh reports on a schedule.
        </p>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Google Ads sync</div>
                <div className="mt-1 text-sm text-slate-600">
                  Last sync: <span className="font-semibold">{fmtDate(lastSyncAt)}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Provider health:{" "}
                  {adsFailure ? (
                    <span className="font-semibold text-rose-700">degraded</span>
                  ) : status?.lastSuccessAt ? (
                    <span className="font-semibold text-emerald-700">healthy</span>
                  ) : (
                    <span className="font-semibold text-slate-600">unknown</span>
                  )}
                </div>
              </div>

              <form action={runGoogleAdsSyncAction}>
                <SubmitButton className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800">
                  Sync now
                </SubmitButton>
              </form>
            </div>

            {!configured ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                Google Ads API is not configured. Set `GOOGLE_ADS_*` env vars on both API + worker.
              </div>
            ) : null}

            {adsFailure && status?.lastFailureDetail ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                <div className="font-semibold">Last error</div>
                <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
                  {status.lastFailureDetail}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Last 7 days</div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
                <div className="text-xs text-slate-500">Clicks</div>
                <div className="mt-1 font-semibold text-slate-900">{fmtNumber(summary?.totals.clicks ?? 0)}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
                <div className="text-xs text-slate-500">Cost</div>
                <div className="mt-1 font-semibold text-slate-900">{fmtMoney(summary?.totals.cost ?? "0")}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
                <div className="text-xs text-slate-500">Conversions</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {Number(summary?.totals.conversions ?? "0").toFixed(0)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
                <div className="text-xs text-slate-500">Impressions</div>
                <div className="mt-1 font-semibold text-slate-900">{fmtNumber(summary?.totals.impressions ?? 0)}</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Next steps</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>After sync, review top search terms and add negatives.</li>
              <li>Pause high-cost / low-conversion terms and tighten locations.</li>
              <li>Run a weekly review request flywheel after completed jobs.</li>
            </ul>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">AI Marketing Analyst</div>
                <div className="mt-1 text-xs text-slate-500">
                  Calls are weighted higher than bookings ({Math.round(safeCallWeight * 100)}% /{" "}
                  {Math.round(safeBookingWeight * 100)}%). Auto-run is off by default.
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Last run:{" "}
                  <span className="font-semibold text-slate-900">{fmtDate(analyst?.latest?.createdAt ?? null)}</span>
                </div>
                {activeReport ? (
                  <div className="mt-1 text-xs text-slate-500">
                    Viewing: <span className="font-semibold text-slate-900">{fmtDate(activeReport.createdAt)}</span>
                    {activeReport.id !== (analyst?.latest?.id ?? "") ? (
                      <span className="ml-2 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                        archived report
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {reportHistory.length > 0 ? (
                  <form method="GET" className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="tab" value="marketing" />
                    <label className="text-xs font-semibold text-slate-700">
                      Report{" "}
                      <select
                        name="gaReportId"
                        defaultValue={selectedReportId ?? ""}
                        className="ml-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-900"
                      >
                        <option value="">Latest</option>
                        {reportHistory.slice(0, 30).map((item) => (
                          <option key={item.id} value={item.id}>
                            {fmtDate(item.createdAt)} - {item.rangeDays}d
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
                    >
                      View
                    </button>
                  </form>
                ) : null}
              </div>

              <div className="flex flex-col items-end gap-2">
                <form action={runGoogleAdsAnalystAction}>
                  <SubmitButton className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800">
                    Generate report
                  </SubmitButton>
                </form>

                {policy ? (
                  <form action={saveGoogleAdsAnalystSettingsAction}>
                    <input type="hidden" name="autonomous" value={policy.autonomous ? "false" : "true"} />
                    <SubmitButton className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50">
                      {policy.autonomous ? "Disable auto-run" : "Enable auto-run"}
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            </div>

            {analystFailure && analyst?.health.lastFailureDetail ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                <div className="font-semibold">Last error</div>
                <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
                  {analyst.health.lastFailureDetail}
                </div>
              </div>
            ) : null}

            {policy ? (
              <div className="mt-3 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-700">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-semibold text-slate-900">
                    Mode:{" "}
                    {policy.autonomous ? (
                      <span className="text-amber-700">auto-run</span>
                    ) : (
                      <span className="text-slate-700">manual</span>
                    )}
                  </span>
                  <span>
                    Negatives thresholds:{" "}
                    <span className="font-semibold text-slate-900">
                      {fmtMoney(String(policy.minSpendForNegatives))}+ spend &amp; {policy.minClicksForNegatives}+ clicks
                    </span>
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Manual mode: only runs when you click Generate report. Auto-run: the worker runs the report daily
                  (still no auto-changes to ads).
                </div>
              </div>
            ) : null}

            {activeReport?.report ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{activeReport.report.summary}</div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Top actions</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">
                    {activeReport.report.top_actions.map((item, idx) => (
                      <li key={`${idx}:${item}`}>{item}</li>
                    ))}
                  </ul>
                </div>

                {(activeReport.report.negatives_to_review?.length ?? 0) > 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Suggested negatives (review)
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {activeReport.report.negatives_to_review.slice(0, 24).map((term) => (
                        <span
                          key={term}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                        >
                          {term}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <GoogleAdsRecommendationsPanel
                  recommendations={recommendations}
                  updateAction={updateGoogleAdsAnalystRecommendationAction}
                />

                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Change log</div>
                  <div className="mt-1 text-xs text-slate-500">Tracks approvals/ignores/applied marks for this report.</div>

                  {changeLog.length === 0 ? (
                    <div className="mt-2 text-sm text-slate-600">
                      No changes yet. Approve/ignore items above to create an audit trail.
                    </div>
                  ) : (
                    <div className="mt-2 divide-y divide-slate-200/70">
                      {changeLog.slice(0, 50).map((evt) => (
                        <div key={evt.id} className="py-2 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-semibold text-slate-900">
                              {evt.kind} • {evt.fromStatus ? `${evt.fromStatus} → ` : ""}
                              {evt.toStatus}
                            </div>
                            <div className="text-xs font-semibold text-slate-600">{fmtDate(evt.createdAt)}</div>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {evt.actorName ?? "Unknown"} ({evt.actorSource})
                            {evt.note ? ` • ${evt.note}` : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {false ? (
                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommendations</div>
                      <div className="mt-1 text-xs text-slate-500">Approve items you want to apply. Nothing auto-applies.</div>
                    </div>
                  </div>

                  {recommendations.length === 0 ? (
                    <div className="mt-2 text-sm text-slate-600">No recommendations yet.</div>
                  ) : (
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead>
                          <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            <th className="py-2 pr-4">Item</th>
                            <th className="py-2 pr-4">Status</th>
                            <th className="py-2 pr-4 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/70">
                          {recommendations.slice(0, 50).map((item) => {
                            const term = String(item.payload["term"] ?? "");
                            const campaignName = String(item.payload["campaignName"] ?? "");
                            const campaignId = String(item.payload["campaignId"] ?? "");
                            const cost = item.payload["cost"];
                            const clicks = item.payload["clicks"];

                            const label =
                              item.kind === "negative_keyword"
                                ? `Negative keyword: ${term}`
                                : item.kind === "pause_candidate"
                                  ? `Review campaign: ${campaignName || campaignId}`
                                  : item.kind;

                            const subtitleParts: string[] = [];
                            if (campaignId) subtitleParts.push(`campaign ${campaignId}`);
                            if (typeof clicks === "number") subtitleParts.push(`${clicks} clicks`);
                            if (typeof cost === "number") subtitleParts.push(`$${cost.toFixed(2)} spend`);

                            return (
                              <tr key={item.id} className="align-top">
                                <td className="py-2 pr-4">
                                  <div className="font-semibold text-slate-900">{label}</div>
                                  {subtitleParts.length > 0 ? (
                                    <div className="text-xs text-slate-500">{subtitleParts.join(" • ")}</div>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-4">
                                  <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
                                    {item.status}
                                  </span>
                                </td>
                                <td className="py-2 pr-4">
                                  <div className="flex justify-end gap-2">
                                    {item.status !== "approved" ? (
                                      <form action={updateGoogleAdsAnalystRecommendationAction}>
                                        <input type="hidden" name="id" value={item.id} />
                                        <input type="hidden" name="status" value="approved" />
                                        <SubmitButton className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                                          Approve
                                        </SubmitButton>
                                      </form>
                                    ) : null}

                                    {item.status !== "ignored" ? (
                                      <form action={updateGoogleAdsAnalystRecommendationAction}>
                                        <input type="hidden" name="id" value={item.id} />
                                        <input type="hidden" name="status" value="ignored" />
                                        <SubmitButton className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50">
                                          Ignore
                                        </SubmitButton>
                                      </form>
                                    ) : null}

                                    {item.status === "approved" ? (
                                      <form action={updateGoogleAdsAnalystRecommendationAction}>
                                        <input type="hidden" name="id" value={item.id} />
                                        <input type="hidden" name="status" value="applied" />
                                        <SubmitButton className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100">
                                          Mark applied
                                        </SubmitButton>
                                      </form>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {approvedNegatives.length > 0 ? (
                    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Approved negatives (copy/paste)
                      </div>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-xs text-slate-900">
                        {approvedNegatives.join("\n")}
                      </pre>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Apply these manually in Google Ads, then click “Mark applied” for each item.
                      </div>
                    </div>
                  ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-600">
                No reports yet. Click <span className="font-semibold">Generate report</span>.
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Top search terms</div>
            <div className="mt-1 text-xs text-slate-500">Sorted by conversions (last 7 days).</div>

            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-4">Search term</th>
                    <th className="py-2 pr-4 text-right">Conv</th>
                    <th className="py-2 pr-4 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70">
                  {(summary?.topSearchTerms ?? []).slice(0, 12).map((row) => (
                    <tr key={`${row.campaignId}:${row.searchTerm}`} className="align-top">
                      <td className="py-2 pr-4">
                        <div className="font-semibold text-slate-900">{row.searchTerm}</div>
                        <div className="text-xs text-slate-500">{row.campaignId}</div>
                      </td>
                      <td className="py-2 pr-4 text-right font-semibold text-slate-900">
                        {Number(row.conversions).toFixed(0)}
                      </td>
                      <td className="py-2 pr-4 text-right font-semibold text-slate-900">{fmtMoney(row.cost)}</td>
                    </tr>
                  ))}
                  {(!summary?.topSearchTerms || summary.topSearchTerms.length === 0) && (
                    <tr>
                      <td className="py-3 text-sm text-slate-600" colSpan={3}>
                        No search term rows yet. Click Sync now.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 border-t border-slate-200/70 pt-4">
              <div className="text-sm font-semibold text-slate-900">Top campaigns</div>
              <div className="mt-1 text-xs text-slate-500">Sorted by conversions (last 7 days).</div>

              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-4">Campaign</th>
                      <th className="py-2 pr-4 text-right">Conv</th>
                      <th className="py-2 pr-4 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/70">
                    {(summary?.topCampaigns ?? []).slice(0, 10).map((row) => (
                      <tr key={row.campaignId} className="align-top">
                        <td className="py-2 pr-4">
                          <div className="font-semibold text-slate-900">{row.campaignName ?? row.campaignId}</div>
                          <div className="text-xs text-slate-500">{row.campaignId}</div>
                        </td>
                        <td className="py-2 pr-4 text-right font-semibold text-slate-900">
                          {Number(row.conversions).toFixed(0)}
                        </td>
                        <td className="py-2 pr-4 text-right font-semibold text-slate-900">{fmtMoney(row.cost)}</td>
                      </tr>
                    ))}
                    {(!summary?.topCampaigns || summary.topCampaigns.length === 0) && (
                      <tr>
                        <td className="py-3 text-sm text-slate-600" colSpan={3}>
                          No campaign rows yet. Click Sync now.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}
