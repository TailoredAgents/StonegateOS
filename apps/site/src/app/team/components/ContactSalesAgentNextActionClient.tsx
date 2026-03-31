"use client";

import React from "react";
import { teamButtonClass } from "./team-ui";

type NextActionPayload = {
  ok?: boolean;
  nextAction?: {
    actionType?: string | null;
    channel?: string | null;
    status?: string | null;
    priority?: string | null;
    confidence?: string | null;
    summary?: string | null;
    reason?: string | null;
    facts?: string[] | null;
    dueAt?: string | null;
    updatedAt?: string | null;
  } | null;
  error?: string;
};

type Props = {
  contactId: string;
};

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

export function ContactSalesAgentNextActionClient({ contactId }: Props): React.ReactElement {
  const [payload, setPayload] = React.useState<NextActionPayload | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("loading");
  const [refreshing, setRefreshing] = React.useState(false);

  const requestUrl = `/api/team/contacts/sales-agent-next-action?contactId=${encodeURIComponent(contactId)}&includeQuotePrice=1`;

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json().catch(() => null)) as NextActionPayload | null;
      if (!response.ok || !data?.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Unable to load next action.");
      }
      setPayload(data);
      setStatus("idle");
    } catch {
      setPayload(null);
      setStatus("error");
    } finally {
      setRefreshing(false);
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
        const data = (await response.json().catch(() => null)) as NextActionPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to load next action.");
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

  const nextAction = payload?.nextAction ?? null;
  const dueAt = formatTimestamp(nextAction?.dueAt);
  const updatedAt = formatTimestamp(nextAction?.updatedAt);
  const facts =
    Array.isArray(nextAction?.facts)
      ? nextAction.facts.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sales Agent</div>
          <div className="text-sm font-semibold text-slate-900">Next best action</div>
        </div>
        <button
          type="button"
          className={teamButtonClass("secondary", "sm")}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="mt-3 space-y-3 text-xs text-slate-600">
        {status === "loading" ? (
          <div>Loading next action...</div>
        ) : status === "error" ? (
          <div className="text-rose-600">Unable to load next action.</div>
        ) : nextAction ? (
          <>
            {nextAction.summary ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                {nextAction.summary}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div className="font-semibold text-slate-700">Action</div>
                <div>{formatLabel(nextAction.actionType)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Channel</div>
                <div>{formatLabel(nextAction.channel)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Priority</div>
                <div>{formatLabel(nextAction.priority)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Confidence</div>
                <div>{formatLabel(nextAction.confidence)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Status</div>
                <div>{formatLabel(nextAction.status)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Due</div>
                <div>{dueAt ?? "No due time"}</div>
              </div>
            </div>

            {nextAction.reason ? (
              <div>
                <div className="font-semibold text-slate-700">Why</div>
                <div>{nextAction.reason}</div>
              </div>
            ) : null}

            {facts.length > 0 ? (
              <div>
                <div className="font-semibold text-slate-700">Facts</div>
                <div className="space-y-1">
                  {facts.slice(0, 4).map((fact) => (
                    <div key={fact}>{fact}</div>
                  ))}
                </div>
              </div>
            ) : null}

            {updatedAt ? (
              <div className="text-[11px] text-slate-500">Updated {updatedAt}</div>
            ) : null}
          </>
        ) : (
          <div>No next action on file yet.</div>
        )}
      </div>
    </div>
  );
}
