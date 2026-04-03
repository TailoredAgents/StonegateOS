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
  autopilot?: {
    mode?: "off" | "partial" | "full" | null;
    channelMode?: "off" | "partial" | "full" | null;
    channel?: string | null;
    plannerAutoSendEnabled?: boolean;
    liveReplyAllowed?: boolean;
  } | null;
  liveContext?: {
    latestLead?: {
      id?: string | null;
    } | null;
    derived?: {
      dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
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

function getLearningSignalFact(facts: string[]): string | null {
  return (
    facts.find((fact) =>
      /tightened weak quotes are booking better than unresolved weak quotes|recent quote follow-ups are booking better|recent quote booking rates are dropping off quickly after the early hot window|this quote is still inside the segment's strong same-day booking window|recent quote bookings are hottest in the|recent quote bookings are arriving later than same day|recent missing-detail requests are resolving better|recent missing-detail requests are stalling|recent appointment acknowledgements are stronger|reschedule requests are turning back into kept appointments|reminder acknowledgements are still soft|appointments are currently canceling or no-showing|recent dormant lead reactivations are reopening better|recent dormant lead reactivations are reopening weakly|recent dormant lead reactivations are not converting strongly|recent agent quote follow-ups are converting better|recent agent quote follow-ups are ending in losses more often than bookings|recent booked jobs are being preserved best after|recent booked jobs are still slipping into cancellations or no-shows|recent lower-confidence instant estimates are landing outside the original range often enough|recent completed jobs are finishing above the original instant range often enough|recent completed jobs are landing outside the original instant range often enough|recent second-touch quote follow-ups are not outperforming enough to justify repeated pushes|recent third-touch quote follow-ups are closing weakly enough that this should stay low pressure|recent later-stage quote follow-ups are performing better when they stay light instead of stacking repeated pushes|recent quote follow-ups are booking better when they stay short|recent quote follow-ups are booking better with one clear ask|recent quote follow-ups are booking better when they lead with one quick photo or walkthrough ask|recent quote follow-ups are underperforming when they push too hard for booking|recent .* saves are reopening better on|recent .* saves are reopening weakly|recent first responses are converting better on|recent first responses are performing better when they go out within 30 minutes|recent first responses are converting better when the opener stays short|recent first responses are converting better when there is one clear ask|recent first responses are converting better when the opener quickly asks for photos or a walkthrough|recent first responses are underperforming when they push too hard for booking right away|recent messenger to text handoffs are carrying over into sms replies often enough|recent messenger to text handoffs are often not carrying over into sms replies|recent messenger to text handoffs are not reopening strongly enough/i.test(
        fact,
      ),
    ) ?? null
  );
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
  const contactOverrideMode = automationState?.dnc
    ? "dnc"
    : isHumanTakeover
      ? "human_takeover"
      : isPaused
        ? "drafts_only"
        : "normal";
  const facts =
    Array.isArray(nextAction?.facts)
      ? nextAction.facts.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
  const learningSignalFact = getLearningSignalFact(facts);
  const executionState = payload?.executionState ?? null;
  const autopilot = payload?.autopilot ?? null;
  const dmEntrySource = payload?.liveContext?.derived?.dmEntrySource ?? null;

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
            {learningSignalFact ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                {learningSignalFact}
              </div>
            ) : null}
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

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Per-contact override</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={teamButtonClass(contactOverrideMode === "drafts_only" ? "primary" : "secondary", "sm")}
                  onClick={() => void runControl("pause")}
                  disabled={actionPending !== null || !canControlAutomation || isPaused}
                >
                  {actionPending === "pause" ? "Saving..." : "Drafts only"}
                </button>
                <button
                  type="button"
                  className={teamButtonClass(contactOverrideMode === "human_takeover" ? "primary" : "secondary", "sm")}
                  onClick={() => void runControl("human_takeover")}
                  disabled={actionPending !== null || !canControlAutomation || isHumanTakeover}
                >
                  {actionPending === "human_takeover" ? "Saving..." : "Human only"}
                </button>
                <button
                  type="button"
                  className={teamButtonClass(contactOverrideMode === "normal" ? "primary" : "secondary", "sm")}
                  onClick={() => void runControl("resume")}
                  disabled={actionPending !== null || !canControlAutomation || (!isPaused && !isHumanTakeover)}
                >
                  {actionPending === "resume" ? "Saving..." : "Resume normal"}
                </button>
                <button
                  type="button"
                  className={teamButtonClass("secondary", "sm")}
                  onClick={() => void runControl("dismiss")}
                  disabled={actionPending !== null || isDismissed}
                >
                  {actionPending === "dismiss" ? "Dismissing..." : isDismissed ? "Dismissed" : "Dismiss action"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              {contactOverrideMode === "dnc"
                ? "This lead is DNC, so automation is blocked until that status is changed elsewhere."
                : contactOverrideMode === "human_takeover"
                  ? "Human only keeps the agent visible, but stops it from acting until you hand the lead back."
                  : contactOverrideMode === "drafts_only"
                    ? "Drafts only pauses automation for this lead while still letting the agent prepare drafts and plans."
                    : "Normal mode follows the current channel autopilot setting."}
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
                <div className="font-semibold text-slate-700">Global mode</div>
                <div>{formatLabel(autopilot?.mode)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Channel mode</div>
                <div>{formatLabel(autopilot?.channelMode)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Action</div>
                <div>{formatLabel(nextAction.actionType)}</div>
              </div>
              <div>
                <div className="font-semibold text-slate-700">Channel</div>
                <div>{formatLabel(nextAction.channel)}</div>
              </div>
              {dmEntrySource ? (
                <div>
                  <div className="font-semibold text-slate-700">Messenger entry</div>
                  <div>{formatLabel(dmEntrySource)}</div>
                </div>
              ) : null}
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

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              {autopilot?.channelMode === "off"
                ? "Off mode: the agent can draft, but nothing on this channel should send automatically."
                : autopilot?.channelMode === "partial"
                  ? "Partial mode: scheduled follow-ups may automate when allowed, but live conversation replies stay approval-only."
                  : autopilot?.channelMode === "full"
                    ? "Full mode: this channel is allowed to run live autopilot where supported."
                    : "Autopilot mode not available."}
            </div>

            {nextAction.reason ? (
              <div>
                <div className="font-semibold text-slate-700">Why</div>
                <div>{nextAction.reason}</div>
              </div>
            ) : null}

            {learningSignalFact ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                Learned signal: {learningSignalFact}
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
