import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  requireCurrentTeamPrincipal,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";
import {
  advertisingContextHref,
  isWebsiteAnalyticsRange,
  normalizeAdvertisingContext,
  normalizeWebsiteAnalyticsRange,
  websiteAnalyticsHref,
  WEBSITE_ANALYTICS_RANGES,
  type WebsiteAnalyticsPanel,
  type WebsiteAnalyticsRange,
} from "./website-analytics-view";

type AnalyticsTimeframe = {
  timezone: "America/New_York";
  since: string;
  through: string;
  generatedAt: string;
  comparison: {
    kind: "previous_equal_period";
    since: string;
    through: string;
  };
};

type AnalyticsPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  timeframe: AnalyticsTimeframe;
};

type WebAnalyticsSummaryPayload = AnalyticsPayload & {
  scope?: { utmCampaign: string | null };
  totals: {
    visits: number;
    pageViews: number;
    callClicks: number;
    bookStep1Views: number;
    bookStep1Submits: number;
    bookQuoteSuccess: number;
    bookBookingSuccess: number;
    bookedAnyChannel: number;
    days: number;
  };
  topPages: Array<{ path: string; pageViews: number }>;
  topSources: Array<{
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    visits: number;
  }>;
};

type WebAnalyticsFunnelPayload = AnalyticsPayload & {
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

type WebAnalyticsErrorsPayload = AnalyticsPayload & {
  items: Array<{
    event: string;
    key: string | null;
    path: string;
    count: number;
  }>;
};

type WebAnalyticsVitalsPayload = AnalyticsPayload & {
  items: Array<{
    path: string;
    metric: string;
    device: string | null;
    samples: number;
    p75: number;
  }>;
};

type AnalyticsResource<T extends AnalyticsPayload> = {
  data: T | null;
  error: string | null;
  checkedAt: string;
};

async function loadAnalyticsResource<T extends AnalyticsPayload>(
  principal: TeamRequestPrincipal,
  path: string,
  label: string,
): Promise<AnalyticsResource<T>> {
  try {
    const response = await callAdminApiAs(principal, path, {
      cache: "no-store",
      timeoutMs: 20_000,
    });
    const checkedAt = new Date().toISOString();
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error.replace(/_/gu, " ")
          : `HTTP ${response.status}`;
      return {
        data: null,
        error: `${label} unavailable: ${detail}.`,
        checkedAt,
      };
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("ok" in payload) ||
      payload.ok !== true ||
      !("timeframe" in payload)
    ) {
      return {
        data: null,
        error: `${label} returned an incomplete response.`,
        checkedAt,
      };
    }
    return { data: payload as T, error: null, checkedAt };
  } catch {
    return {
      data: null,
      error: `${label} is temporarily unavailable.`,
      checkedAt: new Date().toISOString(),
    };
  }
}

function fmtNumber(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US").format(value)
    : "Unavailable";
}

function safeRate(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return Math.min(Math.max(numerator / denominator, 0), 1);
}

function fmtPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not enough data";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtVital(metric: string, value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Unavailable";
  if (metric === "CLS") return value.toFixed(3);
  return `${Math.round(value)} ms`;
}

function fmtEasternTimestamp(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function labelBucket(bucket: string): string {
  if (bucket === "in_area") return "In area";
  if (bucket === "borderline") return "Borderline";
  if (bucket === "out_of_area") return "Out of area";
  return "Unknown";
}

function titleFromSource(
  row: WebAnalyticsSummaryPayload["topSources"][number],
): string {
  const parts = [row.utmSource, row.utmMedium, row.utmCampaign].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  return parts.length ? parts.join(" · ") : "(direct)";
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): React.ReactElement {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
      {detail ? (
        <div className="mt-1 text-xs text-slate-500">{detail}</div>
      ) : null}
    </div>
  );
}

function DataStatus<T extends AnalyticsPayload>({
  resource,
  source,
}: {
  resource: AnalyticsResource<T>;
  source: string;
}): React.ReactElement {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <span
        className={`rounded-full border px-2.5 py-1 font-semibold ${
          resource.data
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-rose-200 bg-rose-50 text-rose-800"
        }`}
      >
        {resource.data ? "Available" : "Unavailable"}
      </span>
      <span>Source: {source}</span>
      <span>Checked {fmtEasternTimestamp(resource.checkedAt)}</span>
      {resource.data ? (
        <span>
          Generated {fmtEasternTimestamp(resource.data.timeframe.generatedAt)}
        </span>
      ) : null}
    </div>
  );
}

function UnavailablePanel<T extends AnalyticsPayload>({
  panel,
  label,
  resource,
  rangeDays,
  advertising,
}: {
  panel: WebsiteAnalyticsPanel;
  label: string;
  resource: AnalyticsResource<T>;
  rangeDays: WebsiteAnalyticsRange;
  advertising: ReturnType<typeof normalizeAdvertisingContext>;
}): React.ReactElement {
  return (
    <div
      className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-900"
      role="alert"
    >
      <div className="font-semibold">{label} unavailable</div>
      <p className="mt-1 text-xs">
        {resource.error ?? "This section did not return complete data."} No zero
        values have been substituted.
      </p>
      <Link
        href={websiteAnalyticsHref({
          rangeDays,
          advertising,
          retryPanel: panel,
          retryToken: resource.checkedAt,
          panel,
        })}
        className={`${teamButtonClass("secondary", "sm")} mt-3`}
      >
        Retry {label}
      </Link>
    </div>
  );
}

export async function WebAnalyticsSection(props: {
  rangeDays?: string;
  gaReportId?: string;
  gaCampaignId?: string;
}): Promise<React.ReactElement> {
  const advertising = normalizeAdvertisingContext({
    reportId: props.gaReportId,
    campaignId: props.gaCampaignId,
  });
  const rangeDays = normalizeWebsiteAnalyticsRange(props.rangeDays);
  if (
    props.rangeDays !== undefined &&
    !isWebsiteAnalyticsRange(props.rangeDays)
  ) {
    redirect(websiteAnalyticsHref({ rangeDays, advertising }));
  }

  const principal = await requireCurrentTeamPrincipal();
  const [summaryResult, funnelResult, errorsResult, vitalsResult] =
    await Promise.all([
      loadAnalyticsResource<WebAnalyticsSummaryPayload>(
        principal,
        `/api/admin/web/analytics/summary?rangeDays=${rangeDays}`,
        "Summary",
      ),
      loadAnalyticsResource<WebAnalyticsFunnelPayload>(
        principal,
        `/api/admin/web/analytics/funnel?rangeDays=${rangeDays}`,
        "Funnel",
      ),
      loadAnalyticsResource<WebAnalyticsErrorsPayload>(
        principal,
        `/api/admin/web/analytics/errors?rangeDays=${rangeDays}`,
        "Errors",
      ),
      loadAnalyticsResource<WebAnalyticsVitalsPayload>(
        principal,
        `/api/admin/web/analytics/vitals?rangeDays=${rangeDays}`,
        "Web Vitals",
      ),
    ]);

  const summary = summaryResult.data;
  const funnel = funnelResult.data;
  const errors = errorsResult.data;
  const vitals = vitalsResult.data;
  const timeframe =
    summary?.timeframe ??
    funnel?.timeframe ??
    errors?.timeframe ??
    vitals?.timeframe ??
    null;
  const errorsRows = errors?.items.slice(0, 12) ?? [];
  const vitalsRows =
    vitals?.items
      .filter((row) =>
        ["/", "/book", "/bookbrush", "/bookdemo"].includes(row.path),
      )
      .sort((left, right) =>
        `${left.path}${left.metric}${left.device ?? ""}`.localeCompare(
          `${right.path}${right.metric}${right.device ?? ""}`,
        ),
      ) ?? [];
  const hasAdvertisingContext = Boolean(
    advertising.reportId || advertising.campaignId,
  );

  return (
    <section className="space-y-4">
      <header className={`${TEAM_CARD_PADDED} space-y-4`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Website analytics</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Privacy-safe first-party public-site events, booking funnel,
              grouped failures, and real-user performance samples.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={advertisingContextHref(advertising)}
              className={teamButtonClass("secondary", "sm")}
            >
              {hasAdvertisingContext
                ? "Open related Ads context"
                : "Open Marketing Ads"}
            </Link>
          </div>
        </div>

        <nav
          aria-label="Website analytics date range"
          className="flex flex-wrap gap-2"
        >
          {WEBSITE_ANALYTICS_RANGES.map((range) => {
            const active = range === rangeDays;
            return (
              <Link
                key={range}
                href={websiteAnalyticsHref({
                  rangeDays: range,
                  advertising,
                })}
                aria-current={active ? "page" : undefined}
                className={`${teamButtonClass(active ? "primary" : "secondary", "sm")} min-h-11`}
              >
                {range === 1 ? "Today" : `${range} days`}
              </Link>
            );
          })}
        </nav>

        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-semibold text-slate-900">
              Eastern-time range
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Calendar days run from midnight through 11:59:59 p.m. in
              America/New_York, including today.
              {timeframe
                ? ` Current period: ${fmtDate(timeframe.since)} through ${fmtDate(timeframe.through)}.`
                : " Exact dates are unavailable until one section loads."}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-semibold text-slate-900">
              Comparison definition
            </div>
            <p className="mt-1 text-xs text-slate-600">
              The comparison period is the immediately preceding, equal-length
              Eastern-time period.
              {timeframe
                ? ` It runs ${fmtDate(timeframe.comparison.since)} through ${fmtDate(timeframe.comparison.through)}.`
                : " Current cards show no comparison when the timeframe is unavailable."}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-semibold text-slate-900">
              Freshness and privacy
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Each section reports its own generated and checked time. Raw
              first-party events expire after 30 days; provider exports allow
              only aggregate source, medium, campaign, and service dimensions.
            </p>
          </div>
        </div>

        {hasAdvertisingContext ? (
          <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
            Advertising context is preserved only in the Ads link:
            {advertising.campaignId
              ? ` campaign ${advertising.campaignId}`
              : " all campaigns"}
            {advertising.reportId ? ` · report ${advertising.reportId}` : ""}.
            It does not alter first-party website totals.
          </div>
        ) : null}
      </header>

      <article id="summary" className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">Summary</h3>
        <p className="mt-1 text-sm text-slate-600">
          Public-site traffic and conversion totals. “Booked any channel” is a
          separate CRM appointment count and is not presented as a web
          conversion.
        </p>
        <DataStatus
          resource={summaryResult}
          source="daily first-party aggregates and non-canceled CRM appointments"
        />
        {summary ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              <MetricCard
                label="Visits"
                value={fmtNumber(summary.totals.visits)}
              />
              <MetricCard
                label="Page views"
                value={fmtNumber(summary.totals.pageViews)}
              />
              <MetricCard
                label="Call clicks"
                value={fmtNumber(summary.totals.callClicks)}
              />
              <MetricCard
                label="Book step 1"
                value={fmtNumber(summary.totals.bookStep1Views)}
                detail={`${fmtPercent(safeRate(summary.totals.bookStep1Submits, summary.totals.bookStep1Views))} submit rate`}
              />
              <MetricCard
                label="Quotes"
                value={fmtNumber(summary.totals.bookQuoteSuccess)}
                detail={`${fmtPercent(safeRate(summary.totals.bookQuoteSuccess, summary.totals.bookStep1Submits))} of submits`}
              />
              <MetricCard
                label="Web bookings"
                value={fmtNumber(summary.totals.bookBookingSuccess)}
                detail={`${fmtPercent(safeRate(summary.totals.bookBookingSuccess, summary.totals.bookQuoteSuccess))} of quotes`}
              />
              <MetricCard
                label="Booked any channel"
                value={fmtNumber(summary.totals.bookedAnyChannel)}
                detail="CRM appointments"
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Data is available. A displayed zero means the aggregate query
              completed and found no matching events; it never means this
              section failed. Events were present on{" "}
              {fmtNumber(summary.totals.days)} of {rangeDays} selected days.
            </p>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <h4 className="text-sm font-semibold text-slate-900">
                  Top pages
                </h4>
                <div className="mt-3 space-y-2 text-sm">
                  {summary.topPages.slice(0, 8).map((row) => (
                    <div
                      key={row.path}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="truncate text-slate-700">
                        {row.path}
                      </span>
                      <span className="text-xs font-semibold text-slate-500">
                        {fmtNumber(row.pageViews)}
                      </span>
                    </div>
                  ))}
                  {!summary.topPages.length ? (
                    <p className="text-slate-600">
                      Available · no page views in this period.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <h4 className="text-sm font-semibold text-slate-900">
                  Top traffic sources
                </h4>
                <div className="mt-3 space-y-2 text-sm">
                  {summary.topSources.slice(0, 8).map((row, index) => (
                    <div
                      key={`${row.utmSource ?? ""}-${row.utmMedium ?? ""}-${row.utmCampaign ?? ""}-${index}`}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="truncate text-slate-700">
                        {titleFromSource(row)}
                      </span>
                      <span className="text-xs font-semibold text-slate-500">
                        {fmtNumber(row.visits)}
                      </span>
                    </div>
                  ))}
                  {!summary.topSources.length ? (
                    <p className="text-slate-600">
                      Available · no UTM visits in this period.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        ) : (
          <UnavailablePanel
            panel="summary"
            label="Summary"
            resource={summaryResult}
            rangeDays={rangeDays}
            advertising={advertising}
          />
        )}
      </article>

      <article id="funnel" className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">Booking funnel</h3>
        <p className="mt-1 text-sm text-slate-600">
          /book, /bookbrush, and /bookdemo progression by service-area bucket.
          Postal codes are converted to a bucket and are never stored here.
        </p>
        <DataStatus
          resource={funnelResult}
          source="first-party raw funnel events"
        />
        {funnel ? (
          <>
            <div className="mt-4 space-y-3 sm:hidden">
              {funnel.byBucket.map((row) => (
                <article
                  key={row.bucket}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm"
                >
                  <div className="font-semibold text-slate-900">
                    {labelBucket(row.bucket)}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600">
                    {[
                      ["Step 1", row.step1Views, null],
                      [
                        "Submit",
                        row.step1Submits,
                        safeRate(row.step1Submits, row.step1Views),
                      ],
                      [
                        "Quote",
                        row.quoteSuccess,
                        safeRate(row.quoteSuccess, row.step1Submits),
                      ],
                      [
                        "Book",
                        row.bookingSuccess,
                        safeRate(row.bookingSuccess, row.quoteSuccess),
                      ],
                    ].map(([label, value, rate]) => (
                      <div key={String(label)}>
                        <div className="font-semibold uppercase tracking-wide text-slate-500">
                          {label}
                        </div>
                        <div className="mt-1 text-sm text-slate-900">
                          {fmtNumber(Number(value))}
                          {rate !== null ? (
                            <span className="ml-1 text-xs text-slate-500">
                              {fmtPercent(Number(rate))}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
              {!funnel.byBucket.length ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
                  Available · no funnel events in this period.
                </div>
              ) : null}
            </div>
            <div className="mt-4 hidden overflow-x-auto sm:block">
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
                  {funnel.byBucket.map((row) => (
                    <tr key={row.bucket}>
                      <td className="px-3 py-3 font-medium text-slate-900">
                        {labelBucket(row.bucket)}
                      </td>
                      <td className="px-3 py-3 text-right text-slate-700">
                        {fmtNumber(row.step1Views)}
                      </td>
                      <td className="px-3 py-3 text-right text-slate-700">
                        {fmtNumber(row.step1Submits)}{" "}
                        <span className="text-xs text-slate-400">
                          {fmtPercent(
                            safeRate(row.step1Submits, row.step1Views),
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-slate-700">
                        {fmtNumber(row.quoteSuccess)}{" "}
                        <span className="text-xs text-slate-400">
                          {fmtPercent(
                            safeRate(row.quoteSuccess, row.step1Submits),
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-slate-700">
                        {fmtNumber(row.bookingSuccess)}{" "}
                        <span className="text-xs text-slate-400">
                          {fmtPercent(
                            safeRate(row.bookingSuccess, row.quoteSuccess),
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!funnel.byBucket.length ? (
                    <tr>
                      <td className="px-3 py-5 text-slate-600" colSpan={5}>
                        Available · no funnel events in this period.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <UnavailablePanel
            panel="funnel"
            label="Funnel"
            resource={funnelResult}
            rangeDays={rangeDays}
            advertising={advertising}
          />
        )}
      </article>

      <div className="grid gap-4 xl:grid-cols-2">
        <article id="errors" className={TEAM_CARD_PADDED}>
          <h3 className="text-lg font-semibold text-slate-900">Errors</h3>
          <p className="mt-1 text-sm text-slate-600">
            Failure events grouped by safe event key and public path. Request
            payload contents are not stored.
          </p>
          <DataStatus
            resource={errorsResult}
            source="daily first-party failure aggregates"
          />
          {errors ? (
            <>
              <div className="mt-4 space-y-3 sm:hidden">
                {errorsRows.map((row) => (
                  <article
                    key={`${row.event}-${row.key ?? ""}-${row.path}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-semibold text-slate-900">
                        {row.event}
                      </span>
                      <span className="text-xs font-semibold text-slate-500">
                        {fmtNumber(row.count)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-slate-600">
                      Key: {row.key ?? "—"}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      Path: {row.path}
                    </div>
                  </article>
                ))}
                {!errorsRows.length ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
                    Available · no failure events in this period.
                  </div>
                ) : null}
              </div>
              <div className="mt-4 hidden overflow-x-auto sm:block">
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
                        <td className="px-3 py-3 font-medium text-slate-900">
                          {row.event}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.key ?? "—"}
                        </td>
                        <td className="px-3 py-3 text-slate-700">{row.path}</td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtNumber(row.count)}
                        </td>
                      </tr>
                    ))}
                    {!errorsRows.length ? (
                      <tr>
                        <td className="px-3 py-5 text-slate-600" colSpan={4}>
                          Available · no failure events in this period.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <UnavailablePanel
              panel="errors"
              label="Errors"
              resource={errorsResult}
              rangeDays={rangeDays}
              advertising={advertising}
            />
          )}
        </article>

        <article id="vitals" className={TEAM_CARD_PADDED}>
          <h3 className="text-lg font-semibold text-slate-900">
            Core Web Vitals
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            p75 first-party real-user samples for /, /book, /bookbrush, and
            /bookdemo.
          </p>
          <DataStatus
            resource={vitalsResult}
            source="first-party real-user performance samples"
          />
          {vitals ? (
            <>
              <div className="mt-4 space-y-3 sm:hidden">
                {vitalsRows.slice(0, 14).map((row) => (
                  <article
                    key={`${row.path}-${row.metric}-${row.device ?? ""}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm"
                  >
                    <div className="font-semibold text-slate-900">
                      {row.path}
                    </div>
                    <div className="mt-2 text-xs text-slate-600">
                      {row.metric} · {row.device ?? "unknown"}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="font-semibold uppercase tracking-wide text-slate-500">
                          Samples
                        </div>
                        <div className="mt-1 text-sm text-slate-900">
                          {fmtNumber(row.samples)}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold uppercase tracking-wide text-slate-500">
                          p75
                        </div>
                        <div className="mt-1 text-sm text-slate-900">
                          {fmtVital(row.metric, row.p75)}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
                {!vitalsRows.length ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
                    Available · no eligible Vitals samples in this period.
                  </div>
                ) : null}
              </div>
              <div className="mt-4 hidden overflow-x-auto sm:block">
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
                        <td className="px-3 py-3 font-medium text-slate-900">
                          {row.path}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.metric}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.device ?? "unknown"}
                        </td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtNumber(row.samples)}
                        </td>
                        <td className="px-3 py-3 text-right text-slate-700">
                          {fmtVital(row.metric, row.p75)}
                        </td>
                      </tr>
                    ))}
                    {!vitalsRows.length ? (
                      <tr>
                        <td className="px-3 py-5 text-slate-600" colSpan={5}>
                          Available · no eligible Vitals samples in this period.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <UnavailablePanel
              panel="vitals"
              label="Web Vitals"
              resource={vitalsResult}
              rangeDays={rangeDays}
              advertising={advertising}
            />
          )}
        </article>
      </div>
    </section>
  );
}
