import React from "react";
import { callAdminApi } from "../lib/api";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

type WebAnalyticsSummaryPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  scope?: { utmCampaign: string | null };
  totals: {
    visits: number;
    pageViews: number;
    callClicks: number;
    bookStep1Views: number;
    bookStep1Submits: number;
    bookQuoteSuccess: number;
    bookBookingSuccess: number;
    days: number;
  };
  topPages: Array<{ path: string; pageViews: number }>;
  topSources: Array<{ utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; visits: number }>;
};

type WebAnalyticsFunnelPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  totals: {
    step1Views: number;
    step2Views: number;
    step1Submits: number;
    quoteSuccess: number;
    bookingSuccess: number;
  };
  byBucket: Array<{
    bucket: string;
    step1Views: number;
    step2Views: number;
    step1Submits: number;
    quoteSuccess: number;
    bookingSuccess: number;
  }>;
};

type WebAnalyticsErrorsPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  items: Array<{ event: string; key: string | null; path: string; count: number }>;
};

type WebAnalyticsVitalsPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  items: Array<{ path: string; metric: string; device: string | null; samples: number; p75: number }>;
};

function clampRangeDays(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Number.isFinite(value) ? value : 0);
}

function fmtPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(Math.max(0, safe));
}

function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.min(Math.max(numerator / denominator, 0), 1);
}

function fmtVital(metric: string, value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "\u2014";
  if (metric === "CLS") return value.toFixed(3);
  return `${Math.round(value)} ms`;
}

function labelBucket(bucket: string): string {
  if (bucket === "in_area") return "In area";
  if (bucket === "borderline") return "Borderline";
  if (bucket === "out_of_area") return "Out of area";
  return "Unknown";
}

function titleFromSource(row: WebAnalyticsSummaryPayload["topSources"][number]): string {
  const parts = [row.utmSource, row.utmMedium, row.utmCampaign].filter((v) => v && v.trim());
  return parts.length ? parts.join(" \u00b7 ") : "(direct)";
}

export async function WebAnalyticsSection(props: {
  rangeDays?: string;
  gaReportId?: string;
  gaCampaignId?: string;
}): Promise<React.ReactElement> {
  const rangeDays = clampRangeDays(props.rangeDays);
  let summary: WebAnalyticsSummaryPayload | null = null;
  let funnel: WebAnalyticsFunnelPayload | null = null;
  let errors: WebAnalyticsErrorsPayload | null = null;
  let vitals: WebAnalyticsVitalsPayload | null = null;
  let error: string | null = null;

  try {
    const [summaryRes, funnelRes, errorsRes, vitalsRes] = await Promise.all([
      callAdminApi(`/api/admin/web/analytics/summary?rangeDays=${rangeDays}`),
      callAdminApi(`/api/admin/web/analytics/funnel?rangeDays=${rangeDays}`),
      callAdminApi(`/api/admin/web/analytics/errors?rangeDays=${rangeDays}`),
      callAdminApi(`/api/admin/web/analytics/vitals?rangeDays=${rangeDays}`)
    ]);

    if (summaryRes.ok) summary = (await summaryRes.json()) as WebAnalyticsSummaryPayload;
    if (funnelRes.ok) funnel = (await funnelRes.json()) as WebAnalyticsFunnelPayload;
    if (errorsRes.ok) errors = (await errorsRes.json()) as WebAnalyticsErrorsPayload;
    if (vitalsRes.ok) vitals = (await vitalsRes.json()) as WebAnalyticsVitalsPayload;

    if (!summaryRes.ok) error = `Website analytics unavailable (HTTP ${summaryRes.status})`;
  } catch {
    error = "Website analytics unavailable.";
  }

  const totals = summary?.totals ?? {
    visits: 0,
    pageViews: 0,
    callClicks: 0,
    bookStep1Views: 0,
    bookStep1Submits: 0,
    bookQuoteSuccess: 0,
    bookBookingSuccess: 0,
    days: 0
  };

  const submitRate = safeRate(totals.bookStep1Submits, totals.bookStep1Views);
  const quoteRate = safeRate(totals.bookQuoteSuccess, totals.bookStep1Submits);
  const bookingRate = safeRate(totals.bookBookingSuccess, totals.bookQuoteSuccess);

  const vitalsRows =
    vitals?.items
      ?.filter((row) => row.path === "/book" || row.path === "/bookbrush" || row.path === "/")
      ?.sort((a, b) => (a.path + a.metric + (a.device ?? "")).localeCompare(b.path + b.metric + (b.device ?? ""))) ?? [];

  const errorsRows = errors?.items?.slice(0, 12) ?? [];

  return (
    <section className={TEAM_CARD_PADDED}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className={TEAM_SECTION_TITLE}>Website analytics</h2>
          <p className={TEAM_SECTION_SUBTITLE}>
            First-party events from the public site only (raw retained for 30 days). Focus: /book + /bookbrush funnel + call clicks.
          </p>
        </div>

        <form method="get" action="/team" className="flex flex-wrap items-center justify-end gap-2 text-sm">
          <input type="hidden" name="tab" value="web-analytics" />
          {props.gaReportId ? <input type="hidden" name="gaReportId" value={props.gaReportId} /> : null}
          {props.gaCampaignId ? <input type="hidden" name="gaCampaignId" value={props.gaCampaignId} /> : null}
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Range</label>
          <select
            name="waRangeDays"
            defaultValue={String(rangeDays)}
            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm"
          >
            <option value="1">Today</option>
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <button type="submit" className={teamButtonClass("secondary", "sm")}>
            Apply
          </button>
        </form>
      </div>

      {error ? (
        <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-sm shadow-rose-100">
          {error}
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid gap-3 md:grid-cols-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visits</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.visits)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Page views</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.pageViews)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Call clicks</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.callClicks)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">/book step 1</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.bookStep1Views)}</div>
              <div className="mt-1 text-xs text-slate-500">{fmtPercent(submitRate)} submit rate</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Quotes</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.bookQuoteSuccess)}</div>
              <div className="mt-1 text-xs text-slate-500">{fmtPercent(quoteRate)} of submits</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bookings</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtNumber(totals.bookBookingSuccess)}</div>
              <div className="mt-1 text-xs text-slate-500">{fmtPercent(bookingRate)} of quotes</div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm font-semibold text-slate-900">/book + /bookbrush funnel by service area</div>
                <div className="text-xs text-slate-500">ZIP is bucketed (never stored).</div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Bucket</th>
                      <th className="px-3 py-2 text-right">Step 1</th>
                      <th className="px-3 py-2 text-right">Submit</th>
                      <th className="px-3 py-2 text-right">Quote</th>
                      <th className="px-3 py-2 text-right">Book</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(funnel?.byBucket ?? []).map((row) => (
                      <tr key={row.bucket}>
                        <td className="px-3 py-3 font-medium text-slate-900">{labelBucket(row.bucket)}</td>
                        <td className="px-3 py-3 text-right text-slate-700">{fmtNumber(row.step1Views)}</td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtNumber(row.step1Submits)}
                          <span className="ml-2 text-xs text-slate-400">{fmtPercent(safeRate(row.step1Submits, row.step1Views))}</span>
                        </td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtNumber(row.quoteSuccess)}
                          <span className="ml-2 text-xs text-slate-400">
                            {fmtPercent(safeRate(row.quoteSuccess, row.step1Submits))}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtNumber(row.bookingSuccess)}
                          <span className="ml-2 text-xs text-slate-400">
                            {fmtPercent(safeRate(row.bookingSuccess, row.quoteSuccess))}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!funnel?.byBucket?.length ? (
                      <tr>
                        <td className="px-3 py-5 text-sm text-slate-500" colSpan={5}>
                          No /book or /bookbrush events in this range yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-sm font-semibold text-slate-900">Top pages</div>
                <div className="mt-3 space-y-2 text-sm">
                  {(summary?.topPages ?? []).slice(0, 8).map((row) => (
                    <div key={row.path} className="flex items-center justify-between gap-3">
                      <div className="truncate text-slate-700">{row.path}</div>
                      <div className="text-xs font-semibold text-slate-500">{fmtNumber(row.pageViews)}</div>
                    </div>
                  ))}
                  {!summary?.topPages?.length ? <div className="text-sm text-slate-500">No page view events yet.</div> : null}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-sm font-semibold text-slate-900">Top traffic sources</div>
                <div className="mt-3 space-y-2 text-sm">
                  {(summary?.topSources ?? []).slice(0, 8).map((row, idx) => (
                    <div key={`${row.utmSource ?? ""}-${row.utmMedium ?? ""}-${row.utmCampaign ?? ""}-${idx}`} className="flex items-center justify-between gap-3">
                      <div className="truncate text-slate-700">{titleFromSource(row)}</div>
                      <div className="text-xs font-semibold text-slate-500">{fmtNumber(row.visits)}</div>
                    </div>
                  ))}
                  {!summary?.topSources?.length ? <div className="text-sm text-slate-500">No UTM traffic yet.</div> : null}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold text-slate-900">Top errors</div>
              <div className="mt-2 text-xs text-slate-500">Grouped by error key (no payload contents stored).</div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Event</th>
                      <th className="px-3 py-2 text-left">Key</th>
                      <th className="px-3 py-2 text-left">Path</th>
                      <th className="px-3 py-2 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {errorsRows.map((row) => (
                      <tr key={`${row.event}-${row.key ?? ""}-${row.path}`}>
                        <td className="px-3 py-3 font-medium text-slate-900">{row.event}</td>
                        <td className="px-3 py-3 text-slate-700">{row.key ?? "\u2014"}</td>
                        <td className="px-3 py-3 text-slate-700">{row.path}</td>
                        <td className="px-3 py-3 text-right text-slate-700">{fmtNumber(row.count)}</td>
                      </tr>
                    ))}
                    {!errorsRows.length ? (
                      <tr>
                        <td className="px-3 py-5 text-sm text-slate-500" colSpan={4}>
                          No fail events captured in this range.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold text-slate-900">Core Web Vitals (p75)</div>
              <div className="mt-2 text-xs text-slate-500">Sampled from real visitors (LCP/CLS only).</div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Path</th>
                      <th className="px-3 py-2 text-left">Metric</th>
                      <th className="px-3 py-2 text-left">Device</th>
                      <th className="px-3 py-2 text-right">Samples</th>
                      <th className="px-3 py-2 text-right">p75</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {vitalsRows.slice(0, 14).map((row) => (
                      <tr key={`${row.path}-${row.metric}-${row.device ?? ""}`}>
                        <td className="px-3 py-3 font-medium text-slate-900">{row.path}</td>
                        <td className="px-3 py-3 text-slate-700">{row.metric}</td>
                        <td className="px-3 py-3 text-slate-700">{row.device ?? "unknown"}</td>
                        <td className="px-3 py-3 text-right text-slate-700">{fmtNumber(row.samples)}</td>
                        <td className="px-3 py-3 text-right text-slate-700">{fmtVital(row.metric, row.p75)}</td>
                      </tr>
                    ))}
                    {!vitalsRows.length ? (
                      <tr>
                        <td className="px-3 py-5 text-sm text-slate-500" colSpan={5}>
                          No vitals captured yet. These populate as visitors browse /, /book, and /bookbrush.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
