import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { runGoogleAdsSyncAction } from "../actions";
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

export async function MarketingSection(): Promise<React.ReactElement> {
  let status: GoogleAdsStatusPayload | null = null;
  let summary: GoogleAdsSummaryPayload | null = null;
  let error: string | null = null;

  try {
    const [statusRes, summaryRes] = await Promise.all([
      callAdminApi("/api/admin/google/ads/status"),
      callAdminApi("/api/admin/google/ads/summary?rangeDays=7")
    ]);

    if (statusRes.ok) {
      status = (await statusRes.json()) as GoogleAdsStatusPayload;
    } else {
      error = `Google Ads status unavailable (HTTP ${statusRes.status})`;
    }

    if (summaryRes.ok) {
      summary = (await summaryRes.json()) as GoogleAdsSummaryPayload;
    }
  } catch {
    error = "Google Ads status unavailable.";
  }

  const configured = status?.configured ?? false;

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Marketing</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Google Ads reporting sync for calls + search terms. This powers weekly optimization and future AI
          recommendations.
        </p>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Google Ads sync</div>
                <div className="mt-1 text-sm text-slate-600">
                  Last fetched: <span className="font-semibold">{fmtDate(status?.lastFetchedAt ?? null)}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Provider health:{" "}
                  {status?.lastSuccessAt ? (
                    <span className="font-semibold text-emerald-700">healthy</span>
                  ) : status?.lastFailureAt ? (
                    <span className="font-semibold text-rose-700">degraded</span>
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

            {status?.lastFailureDetail ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900">
                Last error: {status.lastFailureDetail.slice(0, 200)}
              </div>
            ) : null}

            {error ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900">
                {error}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Last 7 days</div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-slate-700">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Clicks</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {fmtNumber(summary?.totals.clicks ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cost</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {fmtMoney(summary?.totals.cost ?? "0")}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversions</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {Number(summary?.totals.conversions ?? 0).toFixed(0)}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Impressions</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {fmtNumber(summary?.totals.impressions ?? 0)}
                </div>
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
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Top campaigns</div>
                <div className="mt-1 text-xs text-slate-500">Sorted by conversions (last 7 days).</div>
              </div>
            </div>

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
                        No campaign rows yet. Click “Sync now”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                        No search term rows yet. Click “Sync now”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

