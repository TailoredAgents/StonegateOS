import React from "react";
import Link from "next/link";
import {
  formatOpenAiAdsReportCount,
  formatOpenAiAdsReportDate,
  formatOpenAiAdsReportMoney,
  formatOpenAiAdsReportTimestamp,
  openAiAdsReportActivityState,
  type OpenAiAdsCampaignReportState,
} from "../lib/openai-ads-reporting-model";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_FOCUS_RING,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";

export function OpenAiAdsCampaignReportView({
  state,
  refreshHref,
}: {
  state: OpenAiAdsCampaignReportState;
  refreshHref: string;
}): React.ReactElement {
  const report = state.kind === "ready" ? state.report : null;
  const activity = report ? openAiAdsReportActivityState(report) : null;
  return (
    <article id="chatgpt-campaigns" className={TEAM_CARD_PADDED}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[color:var(--team-text)]">
            ChatGPT campaign performance
          </h3>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Campaign spend, traffic, and conversions attributed by ChatGPT Ads.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={refreshHref}
            prefetch={false}
            className={teamButtonClass("secondary", "sm")}
          >
            Refresh report
          </Link>
          <a
            href="https://ads.openai.com/"
            target="_blank"
            rel="noopener noreferrer"
            className={teamButtonClass("secondary", "sm")}
          >
            Ads Manager
          </a>
        </div>
      </div>
      {report ? (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--team-text-muted)]">
            <span>{report.account.name}</span>
            <span>
              {formatOpenAiAdsReportDate(report.timeframe.since)} –{" "}
              {formatOpenAiAdsReportDate(report.timeframe.through)}
            </span>
            <span>Report timezone: {report.timeframe.timezone}</span>
            <span>Account timezone: {report.account.timeZone}</span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              {
                label: "Spend",
                value: formatOpenAiAdsReportMoney(
                  report.totals.spend,
                  report.account.currency,
                ),
              },
              {
                label: "Impressions",
                value: formatOpenAiAdsReportCount(report.totals.impressions),
              },
              {
                label: "Clicks",
                value: formatOpenAiAdsReportCount(report.totals.clicks),
              },
              {
                label: "Attributed conversions",
                value: formatOpenAiAdsReportCount(
                  report.totals.attributedConversions,
                ),
              },
              {
                label: "Cost per conversion",
                value: formatOpenAiAdsReportMoney(
                  (report.totals.attributedConversions ?? 0) > 0
                    ? report.totals.costPerConversion
                    : null,
                  report.account.currency,
                ),
              },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="min-w-0 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
              >
                <dt className="text-xs font-medium text-[color:var(--team-text-muted)]">
                  {label}
                </dt>
                <dd className="mt-2 break-words text-xl font-semibold text-[color:var(--team-text)]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[color:var(--team-text-muted)]">
            <div>
              <dt className="inline">Attributed bookings: </dt>
              <dd className="inline font-semibold text-[color:var(--team-text)]">
                {formatOpenAiAdsReportCount(
                  report.conversionBreakdownAvailable
                    ? report.totals.bookingConversions
                    : null,
                )}
              </dd>
            </div>
            <div>
              <dt className="inline">Attributed phone inquiries: </dt>
              <dd className="inline font-semibold text-[color:var(--team-text)]">
                {formatOpenAiAdsReportCount(
                  report.conversionBreakdownAvailable
                    ? report.totals.phoneInquiryConversions
                    : null,
                )}
              </dd>
            </div>
          </dl>
          {!report.conversionBreakdownAvailable ? (
            <p className="mt-2 text-xs text-[color:var(--team-text-muted)]">
              ChatGPT reports these outcomes together; separate booking and
              phone totals are unavailable.
            </p>
          ) : null}
          {activity === "none" ? (
            <div className={`${TEAM_EMPTY_STATE} mt-4`}>
              No ad activity was reported for the selected period.
            </div>
          ) : activity === "unavailable" ? (
            <div className={`${TEAM_EMPTY_STATE} mt-4`}>
              Some performance totals are unavailable for the selected period.
            </div>
          ) : null}
          {report.campaigns.length > 0 ? (
            <div
              className={`mt-4 overflow-x-auto ${TEAM_FOCUS_RING}`}
              role="region"
              aria-label="Campaign performance table"
              tabIndex={0}
            >
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">
                  ChatGPT campaign performance for the selected period
                </caption>
                <thead className="text-xs text-[color:var(--team-text-muted)]">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Campaign
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Spend
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Impressions
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Clicks
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Attributed conversions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.campaigns.map((campaign) => (
                    <tr
                      key={campaign.id}
                      className="border-t border-[color:var(--team-border)]"
                    >
                      <th
                        scope="row"
                        className="max-w-64 py-3 pr-4 font-medium text-[color:var(--team-text)]"
                      >
                        <span className="break-words">{campaign.name}</span>
                        {campaign.status ? (
                          <span className="mt-1 block text-xs font-normal capitalize text-[color:var(--team-text-muted)]">
                            {campaign.status.replace(/_/gu, " ")}
                          </span>
                        ) : null}
                      </th>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        {formatOpenAiAdsReportMoney(
                          campaign.spend,
                          report.account.currency,
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {formatOpenAiAdsReportCount(campaign.impressions)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {formatOpenAiAdsReportCount(campaign.clicks)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {formatOpenAiAdsReportCount(
                          campaign.attributedConversions,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : activity === "active" ? (
            <p className="mt-4 text-sm text-[color:var(--team-text-muted)]">
              Campaign details were not included in this report.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-[color:var(--team-text-muted)]">
            Fetched{" "}
            {formatOpenAiAdsReportTimestamp(
              report.fetchedAt,
              report.timeframe.timezone,
            )}
            . Source: ChatGPT Ads reporting. Today is partial; spend can
            finalize after traffic. Totals count click-through conversion events
            on the action date. A customer who calls and books can count as two
            conversions. Conversions update daily and may take a day or longer
            to appear. Reporting begins when conversion settings are attached to
            a campaign.
          </p>
        </>
      ) : (
        <div
          className={`${teamStatePanelClass(state.kind === "not_configured" ? "info" : "warning")} mt-4`}
          role="status"
        >
          {state.kind === "not_configured" ? (
            <>
              <p className="font-semibold">
                Advertiser reporting is not connected
              </p>
              <p className="mt-1">
                Connect the company&apos;s ChatGPT advertiser account to load
                campaign performance.
              </p>
            </>
          ) : state.kind === "forbidden" ? (
            <>
              <p className="font-semibold">
                Campaign reporting access is unavailable
              </p>
              <p className="mt-1">
                Your team session needs Marketing access to view this report.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">Campaign report unavailable</p>
              <p className="mt-1">
                ChatGPT Ads did not return a complete report. Refresh to try
                again.
              </p>
            </>
          )}
        </div>
      )}
    </article>
  );
}
