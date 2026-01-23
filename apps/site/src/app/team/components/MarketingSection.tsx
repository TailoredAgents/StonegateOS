import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { runGoogleAdsAnalystAction, runGoogleAdsSyncAction, saveGoogleAdsAnalystSettingsAction } from "../actions";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE } from "./team-ui";

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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
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

export async function MarketingSection(): Promise<React.ReactElement> {
  let status: GoogleAdsStatusPayload | null = null;
  let summary: GoogleAdsSummaryPayload | null = null;
  let analyst: GoogleAdsAnalystStatusPayload | null = null;
  let error: string | null = null;

  try {
    const [statusRes, summaryRes, analystRes] = await Promise.all([
      callAdminApi("/api/admin/google/ads/status"),
      callAdminApi("/api/admin/google/ads/summary?rangeDays=7"),
      callAdminApi("/api/admin/google/ads/analyst/status")
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

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Marketing</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Google Ads sync and AI analysis. Default behavior is safe: nothing changes in Google Ads unless you explicitly
          turn on autonomous mode (and even then, we only generate recommendations today).
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
                  {Math.round(safeBookingWeight * 100)}%). Autonomous mode is off by default.
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Last run:{" "}
                  <span className="font-semibold text-slate-900">{fmtDate(analyst?.latest?.createdAt ?? null)}</span>
                </div>
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
                      {policy.autonomous ? "Disable autonomous" : "Enable autonomous"}
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
                      <span className="text-amber-700">autonomous</span>
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
                  Manual mode: only runs when you click Generate report. Autonomous mode: the worker runs the report
                  daily (still no auto-changes to ads).
                </div>
              </div>
            ) : null}

            {analyst?.latest?.report ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{analyst.latest.report.summary}</div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Top actions</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">
                    {analyst.latest.report.top_actions.map((item, idx) => (
                      <li key={`${idx}:${item}`}>{item}</li>
                    ))}
                  </ul>
                </div>

                {(analyst.latest.report.negatives_to_review?.length ?? 0) > 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Suggested negatives (review)
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {analyst.latest.report.negatives_to_review.slice(0, 24).map((term) => (
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

