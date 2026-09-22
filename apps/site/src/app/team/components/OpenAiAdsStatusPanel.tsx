import React from "react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { TEAM_CARD_PADDED, teamButtonClass } from "./team-ui";

type DeliveryCounts = {
  queued: number;
  delivered: number;
  quarantined: number;
  retrying: number;
  suppressed?: number;
};

type ConversionStatus = {
  ok: true;
  configuration: { enabled: boolean; configured: boolean };
  dispatchBlocked: unknown;
  periodStart: string;
  totals: DeliveryCounts;
  events: Array<
    DeliveryCounts & { type: "booking" | "phone_inquiry" | "other" }
  >;
  latestDeliveryAt: string | null;
};

function count(value: number | undefined): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export async function OpenAiAdsStatusPanel({
  principal,
  rangeDays,
}: {
  principal: TeamRequestPrincipal;
  rangeDays: number;
}): Promise<React.ReactElement> {
  let status: ConversionStatus | null = null;
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/openai/ads/status?rangeDays=${rangeDays}`,
      { timeoutMs: 8_000 },
    );
    if (response.ok) {
      const payload = (await response.json()) as ConversionStatus;
      if (
        payload.ok === true &&
        payload.configuration &&
        Array.isArray(payload.events)
      ) {
        status = payload;
      }
    }
  } catch {
    // A provider-status outage must not hide the rest of Website Analytics.
  }

  const state = !status
    ? "Status unavailable"
    : !status.configuration.configured
      ? "Setup required"
      : !status.configuration.enabled || status.dispatchBlocked
        ? "Delivery paused"
        : status.totals.quarantined > 0
          ? "Needs attention"
          : "Ready to send";
  const rows = [
    { type: "booking", label: "Confirmed bookings" },
    { type: "phone_inquiry", label: "Phone inquiries" },
  ] as const;

  return (
    <article id="chatgpt-ads" className={TEAM_CARD_PADDED}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            ChatGPT Ads conversions
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {state}. Delivery totals for the selected period.
          </p>
        </div>
        <a
          href="https://ads.openai.com/"
          target="_blank"
          rel="noopener noreferrer"
          className={teamButtonClass("secondary", "sm")}
        >
          Open ChatGPT Ads Manager
        </a>
      </div>
      {status ? (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Delivery of booking and phone inquiry conversions to OpenAI
              </caption>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Outcome
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Accepted
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Waiting to send
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Needs review
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const values = status.events.find(
                    (event) => event.type === row.type,
                  );
                  return (
                    <tr key={row.type} className="border-t border-slate-100">
                      <th
                        scope="row"
                        className="py-3 pr-4 font-medium text-slate-900"
                      >
                        {row.label}
                      </th>
                      <td className="px-3 py-3">{count(values?.delivered)}</td>
                      <td className="px-3 py-3">{count(values?.queued)}</td>
                      <td className="px-3 py-3">
                        {count(values?.quarantined)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {status.latestDeliveryAt
              ? `Last accepted: ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(status.latestDeliveryAt))} Eastern.`
              : "No accepted server conversions in this period."}
            {status.totals.retrying > 0
              ? ` ${count(status.totals.retrying)} deliveries are retrying.`
              : ""}
            {(status.totals.suppressed ?? 0) > 0
              ? ` ${count(status.totals.suppressed)} events were withheld after an opt-out.`
              : ""}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-600">
          Refresh this page to try loading conversion delivery status again.
        </p>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Accepted means OpenAI received the event. Ads Manager determines which
        events are attributed to an ad; attributed totals may differ. Phone
        inquiries require a qualifying connected call and a recent website
        measurement record. Call-button clicks are reported separately in
        website analytics.
      </p>
    </article>
  );
}
