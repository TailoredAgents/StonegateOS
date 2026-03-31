"use client";

import React from "react";
import { teamButtonClass } from "./team-ui";

type NextActionPayload = {
  ok?: boolean;
  nextAction?: {
    id?: string | null;
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
  executionState?: {
    code?: string | null;
    label?: string | null;
    detail?: string | null;
    tone?: "good" | "warn" | "bad" | "neutral" | null;
  } | null;
  liveContext?: {
    latestLead?: {
      id?: string | null;
    } | null;
    automation?: Array<{
      channel?: string | null;
      paused?: boolean;
      dnc?: boolean;
      humanTakeover?: boolean;
    }> | null;
  } | null;
  error?: string;
};

type Props = {
  contactId: string;
  compact?: boolean;
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

function toneClasses(value: "good" | "warn" | "bad" | "neutral" | null | undefined): string {
  if (value === "good") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "warn") return "border-amber-200 bg-amber-50 text-amber-800";
  if (value === "bad") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function ContactSalesAgentNextActionClient({ contactId, compact = false }: Props): React.ReactElement {
  const [payload, setPayload] = React.useState<NextActionPayload | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("loading");
  const [refreshing, setRefreshing] = React.useState(false);
  const [actionPending, setActionPending] = React.useState<string | null>(null);

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
  const automationState =
    (payload?.liveContext?.automation ?? []).find((row) => row?.channel === nextAction?.channel) ?? null;
  const leadId = payload?.liveContext?.latestLead?.id ?? null;
  const canControlAutomation = Boolean(leadId && nextAction?.channel);
  const isDismissed = nextAction?.status === "dismissed";
  const isPaused = automationState?.paused === true;
  const isHumanTakeover = automationState?.humanTakeover === true;
  const facts =
    Array.isArray(nextAction?.facts)
      ? nextAction.facts.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
  const executionState = payload?.executionState ?? null;

  const runControl = React.useCallback(
    async (action: "dismiss" | "pause" | "human_takeover" | "resume") => {
      setActionPending(action);
      try {
        const response = await fetch(requestUrl, {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            channel: nextAction?.channel ?? null,
          }),
        });
        const data = (await response.json().catch(() => null)) as NextActionPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to update controls.");
        }
        setPayload(data);
        setStatus("idle");
      } catch {
        setStatus("error");
      } finally {
        setActionPending(null);
      }
    },
    [requestUrl, nextAction?.channel],
  );

  if (compact) {
    return (
      <div className={`rounded-2xl border p-3 text-xs ${toneClasses(executionState?.tone)}`}>
        {status === "loading" ? (
          <div>Loading agent state...</div>
        ) : status === "error" ? (
          <div>Unable to load agent state.</div>
        ) : executionState?.label ? (
          <>
            <div className="font-semibold uppercase tracking-wide">{executionState.label}</div>
            {executionState.detail ? <div className="mt-1 text-[11px] opacity-90">{executionState.detail}</div> : null}
          </>
        ) : nextAction?.summary ? (
          <div>{nextAction.summary}</div>
        ) : (
          <div>No agent state yet.</div>
        )}
      </div>
    );
  }

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
            {executionState?.label ? (
              <div className={`rounded-xl border px-3 py-2 text-[11px] ${toneClasses(executionState.tone)}`}>
                <div className="font-semibold uppercase tracking-wide">{executionState.label}</div>
                {executionState.detail ? <div className="mt-1 normal-case tracking-normal">{executionState.detail}</div> : null}
              </div>
            ) : null}

            {nextAction.summary ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                {nextAction.summary}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={teamButtonClass("secondary", "sm")}
                onClick={() => void runControl("dismiss")}
                disabled={actionPending !== null || isDismissed}
              >
                {actionPending === "dismiss" ? "Dismissing..." : isDismissed ? "Dismissed" : "Dismiss"}
              </button>
              <button
                type="button"
                className={teamButtonClass("secondary", "sm")}
                onClick={() => void runControl("pause")}
                disabled={actionPending !== null || !canControlAutomation || isPaused}
              >
                {actionPending === "pause" ? "Pausing..." : isPaused ? "Paused" : "Pause"}
              </button>
              <button
                type="button"
                className={teamButtonClass("secondary", "sm")}
                onClick={() => void runControl("human_takeover")}
                disabled={actionPending !== null || !canControlAutomation || isHumanTakeover}
              >
                {actionPending === "human_takeover"
                  ? "Setting..."
                  : isHumanTakeover
                    ? "Human takeover"
                    : "Human takeover"}
              </button>
              <button
                type="button"
                className={teamButtonClass("secondary", "sm")}
                onClick={() => void runControl("resume")}
                disabled={actionPending !== null || !canControlAutomation || (!isPaused && !isHumanTakeover)}
              >
                {actionPending === "resume" ? "Resuming..." : "Resume"}
              </button>
            </div>

            {(isPaused || isHumanTakeover || automationState?.dnc) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                {automationState?.dnc
                  ? "Automation is effectively blocked because this lead is DNC."
                  : isHumanTakeover
                    ? "Human takeover is active on the planner channel."
                    : "Automation is paused on the planner channel."}
              </div>
            )}

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
