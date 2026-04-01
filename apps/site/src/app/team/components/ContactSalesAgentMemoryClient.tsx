"use client";

import React from "react";
import { teamButtonClass } from "./team-ui";

type SalesAgentMemoryPayload = {
  ok?: boolean;
  memory?: {
    summary?: string | null;
    customerIntent?: string | null;
    jobType?: string | null;
    pricingContext?: string | null;
    objections?: string[] | null;
    channelPreference?: string | null;
    lastPromisedNextStep?: string | null;
    lastHumanSummary?: string | null;
    bookingReadiness?: string | null;
    quoteConfidence?: string | null;
    missingFields?: string[] | null;
    updatedAt?: string | null;
  } | null;
  liveContext?: {
    derived?: {
      dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
    } | null;
  } | null;
  error?: string;
};

type Props = {
  contactId: string;
};

function formatList(items: string[] | null | undefined): string {
  const safe = Array.isArray(items)
    ? items.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  return safe.length > 0 ? safe.join(", ") : "None";
}

function formatLabel(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Unknown";
  return value
    .split("_")
    .filter((part) => part.trim().length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export function ContactSalesAgentMemoryClient({ contactId }: Props): React.ReactElement {
  const [payload, setPayload] = React.useState<SalesAgentMemoryPayload | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("loading");
  const [rebuilding, setRebuilding] = React.useState(false);

  const requestUrl = `/api/team/contacts/sales-agent-memory?contactId=${encodeURIComponent(contactId)}&includeQuotePrice=1`;

  const loadMemory = React.useCallback(async () => {
    setRebuilding(true);
    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json().catch(() => null)) as SalesAgentMemoryPayload | null;
      if (!response.ok || !data?.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Unable to load agent memory.");
      }
      setPayload(data);
      setStatus("idle");
    } catch {
      setPayload(null);
      setStatus("error");
    } finally {
      setRebuilding(false);
    }
  }, [requestUrl]);

  React.useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");

    void (async () => {
      try {
        const response = await fetch(requestUrl, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => null)) as SalesAgentMemoryPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to load agent memory.");
        }
        setPayload(data);
        setStatus("idle");
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setPayload(null);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [requestUrl]);

  const memory = payload?.memory ?? null;
  const updatedAt = formatTimestamp(memory?.updatedAt);
  const dmEntrySource = payload?.liveContext?.derived?.dmEntrySource ?? null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sales Agent</div>
          <div className="text-sm font-semibold text-slate-900">Agent memory</div>
        </div>
        <button
          type="button"
          className={teamButtonClass("secondary", "sm")}
          onClick={() => void loadMemory()}
          disabled={rebuilding}
        >
          {rebuilding ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="mt-3 space-y-3 text-xs text-slate-600">
        {status === "loading" ? (
          <div>Loading agent memory...</div>
        ) : status === "error" ? (
          <div className="text-rose-600">Unable to load agent memory.</div>
        ) : memory ? (
          <>
            {memory.summary ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                {memory.summary}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="font-semibold text-slate-700">Intent</div>
                <div>{formatLabel(memory.customerIntent)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Preferred channel</div>
                <div>{formatLabel(memory.channelPreference)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Booking readiness</div>
                <div>{formatLabel(memory.bookingReadiness)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Quote confidence</div>
                <div>{formatLabel(memory.quoteConfidence)}</div>
              </div>
              {dmEntrySource ? (
                <div>
                  <div className="font-semibold text-slate-700">Messenger entry</div>
                  <div>{formatLabel(dmEntrySource)}</div>
                </div>
              ) : null}
            </div>

            {memory.pricingContext ? (
              <div>
                <div className="font-semibold text-slate-700">Pricing context</div>
                <div>{memory.pricingContext}</div>
              </div>
            ) : null}

            {memory.lastPromisedNextStep ? (
              <div>
                <div className="font-semibold text-slate-700">Last promised next step</div>
                <div>{memory.lastPromisedNextStep}</div>
              </div>
            ) : null}

            {memory.lastHumanSummary ? (
              <div>
                <div className="font-semibold text-slate-700">Last human summary</div>
                <div>{memory.lastHumanSummary}</div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="font-semibold text-slate-700">Missing fields</div>
                <div>{formatList(memory.missingFields)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Objections</div>
                <div>{formatList(memory.objections)}</div>
              </div>
            </div>

            {updatedAt ? (
              <div className="text-[11px] text-slate-500">Updated {updatedAt}</div>
            ) : null}
          </>
        ) : (
          <div>No agent memory on file yet.</div>
        )}
      </div>
    </div>
  );
}
