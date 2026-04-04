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
  recentHumanReview?: {
    active?: boolean;
    label?: string | null;
    detail?: string | null;
    updatedAt?: string | null;
  } | null;
  autopilot?: {
    mode?: "off" | "partial" | "full" | null;
    channelMode?: "off" | "partial" | "full" | null;
    channel?: string | null;
    plannerAutoSendEnabled?: boolean;
    liveReplyAutonomyEnabled?: boolean;
    liveReplyAllowed?: boolean;
  } | null;
  liveContext?: {
    latestLead?: {
      id?: string | null;
    } | null;
    derived?: {
      dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
      exceptionSignals?: string[] | null;
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

function formatActionLabel(value: string | null | undefined): string {
  switch (value) {
    case "appointment_checkin":
      return "Pre-appointment check in";
    case "appointment_support":
      return "Appointment support";
    case "post_job_checkin":
      return "Post-job check in";
    case "wait_for_appointment":
      return "Appointment on the books";
    case "human_follow_up":
      return "Needs human review";
    default:
      return formatLabel(value);
  }
}

function getLifecycleStageSummary(actionType: string | null | undefined): {
  label: string;
  detail: string;
} | null {
  switch (actionType) {
    case "appointment_checkin":
      return {
        label: "Pre-appointment protection",
        detail: "The agent wants to send a light reassurance touch before the booked appointment.",
      };
    case "appointment_support":
      return {
        label: "Booked-job support",
        detail: "The customer is already booked and the next move is handling timing, logistics, or a light reschedule-save reply.",
      };
    case "post_job_checkin":
      return {
        label: "Post-job follow-up",
        detail: "The job is done and the next move is a short human-style satisfaction check-in.",
      };
    default:
      return null;
  }
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

function summarizeExceptionSignals(signals: string[]): { headline: string; details: string[] } | null {
  if (signals.length === 0) return null;

  const details: string[] = [];
  if (signals.includes("frustrated_or_dispute")) {
    details.push("Customer tone suggests frustration, dispute risk, or a complaint path.");
  }
  if (signals.includes("hazardous_scope")) {
    details.push("Scope may involve hazardous or unsupported material.");
  }
  if (signals.includes("high_risk_demo_scope")) {
    details.push("Demolition scope looks larger or riskier than the normal auto-handled jobs.");
  }
  if (signals.includes("scope_pricing_contradiction")) {
    details.push("Photos, stated scope, and quote signals disagree too much to trust the next pricing touch.");
  }
  if (signals.includes("schedule_urgency_contradiction")) {
    details.push("Requested timing conflicts with the current appointment or quote assumptions.");
  }
  if (signals.includes("operational_scope_contradiction")) {
    details.push("Access, carry, or multi-area scope looks more complex than the current estimate assumptions.");
  }
  if (signals.includes("out_of_area")) {
    details.push("Known ZIP appears outside the current service-area policy.");
  }
  if (signals.includes("unsupported_service_scope")) {
    details.push("Requested work may fall outside the supported junk, brush, or approved demo scope.");
  }

  return {
    headline:
      details.length === 1
        ? "Held for human review because one material risk was detected."
        : `Held for human review because ${details.length} separate risk signals were detected.`,
    details,
  };
}

function compactText(value: string | null | undefined, maxLen = 220): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function ContactSalesAgentNextActionClient({ contactId, compact = false }: Props): React.ReactElement {
  const [payload, setPayload] = React.useState<NextActionPayload | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("loading");
  const [refreshing, setRefreshing] = React.useState(false);
  const [actionPending, setActionPending] = React.useState<string | null>(null);
  const [reviewNote, setReviewNote] = React.useState("");

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
  const recentHumanReview = payload?.recentHumanReview ?? null;
  const recentHumanReviewUpdatedAt = formatTimestamp(recentHumanReview?.updatedAt);
  const recentHumanReviewDetail = compactText(recentHumanReview?.detail, compact ? 140 : 260);
  const autopilot = payload?.autopilot ?? null;
  const dmEntrySource = payload?.liveContext?.derived?.dmEntrySource ?? null;
  const exceptionSignals = Array.isArray(payload?.liveContext?.derived?.exceptionSignals)
    ? payload?.liveContext?.derived?.exceptionSignals.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const exceptionSummary = summarizeExceptionSignals(exceptionSignals);
  const isHumanReviewHold =
    nextAction?.actionType === "human_follow_up" || executionState?.code === "human_review" || exceptionSummary !== null;
  const canResumeToAgent = canControlAutomation && (isPaused || isHumanTakeover);
  const lifecycleStage = getLifecycleStageSummary(nextAction?.actionType);

  const runControl = React.useCallback(
    async (action: "dismiss" | "pause" | "human_takeover" | "resume") => {
      setActionPending(action);
      try {
        const trimmedReviewNote = reviewNote.trim();
        const response = await fetch(requestUrl, {
          method: "PATCH",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            channel: nextAction?.channel ?? null,
            reviewNote:
              action === "dismiss" || action === "resume"
                ? trimmedReviewNote || null
                : null,
          }),
        });
        const data = (await response.json().catch(() => null)) as NextActionPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to update controls.");
        }
        setPayload(data);
        setStatus("idle");
        if (action === "dismiss" || action === "resume") {
          setReviewNote("");
        }
      } catch {
        setStatus("error");
      } finally {
        setActionPending(null);
      }
    },
    [requestUrl, nextAction?.channel, reviewNote],
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
            {lifecycleStage ? (
              <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] text-sky-800">
                <div className="font-medium">{lifecycleStage.label}</div>
                <div className="mt-1">{lifecycleStage.detail}</div>
              </div>
            ) : null}
            {learningSignalFact ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                {learningSignalFact}
              </div>
            ) : null}
            {recentHumanReview?.active ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                <div className="font-medium">{recentHumanReview.label ?? "Recently reviewed"}</div>
                {recentHumanReviewDetail ? <div className="mt-1">{recentHumanReviewDetail}</div> : null}
                {recentHumanReviewUpdatedAt ? <div className="mt-1 text-amber-800">{recentHumanReviewUpdatedAt}</div> : null}
              </div>
            ) : null}
            {exceptionSummary ? (
              <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">
                <div className="font-medium">Human review hold</div>
                <div className="mt-1">{exceptionSummary.headline}</div>
                {exceptionSummary.details.slice(0, 2).map((detail) => (
                  <div key={detail} className="mt-1">
                    {detail}
                  </div>
                ))}
              </div>
            ) : null}
            {isHumanReviewHold ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value.slice(0, 1000))}
                  rows={2}
                  placeholder="Optional review note for the agent"
                  className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none transition focus:border-slate-400"
                  disabled={actionPending !== null}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={teamButtonClass("secondary", "sm")}
                    onClick={() => void runControl("dismiss")}
                    disabled={actionPending !== null || isDismissed}
                  >
                    {actionPending === "dismiss" ? "Clearing..." : isDismissed ? "Hold cleared" : "Mark reviewed"}
                  </button>
                  {canResumeToAgent ? (
                    <button
                      type="button"
                      className={teamButtonClass("primary", "sm")}
                      onClick={() => void runControl("resume")}
                      disabled={actionPending !== null}
                    >
                      {actionPending === "resume" ? "Saving..." : "Hand back to agent"}
                    </button>
                  ) : null}
                </div>
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

            {lifecycleStage ? (
              <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-900">
                <div className="font-semibold uppercase tracking-wide text-sky-700">{lifecycleStage.label}</div>
                <div className="mt-1">{lifecycleStage.detail}</div>
              </div>
            ) : null}

            {isHumanReviewHold ? (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Human review resolution</div>
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value.slice(0, 1000))}
                  rows={3}
                  placeholder="Optional review note for the agent"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400"
                  disabled={actionPending !== null}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={teamButtonClass("secondary", "sm")}
                    onClick={() => void runControl("dismiss")}
                    disabled={actionPending !== null || isDismissed}
                  >
                    {actionPending === "dismiss" ? "Clearing..." : isDismissed ? "Hold cleared" : "Mark reviewed"}
                  </button>
                  {canResumeToAgent ? (
                    <button
                      type="button"
                      className={teamButtonClass("primary", "sm")}
                      onClick={() => void runControl("resume")}
                      disabled={actionPending !== null}
                    >
                      {actionPending === "resume" ? "Saving..." : "Hand back to agent"}
                    </button>
                  ) : null}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                  Mark reviewed clears the current human-review hold from the queue. Hand back to agent also resumes normal automation if this lead was manually paused. Any note you add here is saved into the contact notes the agent already reads.
                </div>
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
                <div>{formatActionLabel(nextAction.actionType)}</div>
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
                    ? autopilot?.liveReplyAutonomyEnabled
                      ? "Full mode: this channel can run live autopilot where supported and approved."
                      : "Full mode is set, but live reply autonomy is still off until you enable it in Automation."
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

            {recentHumanReview?.active ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                <div className="font-semibold">{recentHumanReview.label ?? "Recently reviewed"}</div>
                {recentHumanReviewDetail ? <div className="mt-1">{recentHumanReviewDetail}</div> : null}
                {recentHumanReviewUpdatedAt ? (
                  <div className="mt-1 text-amber-800">Saved {recentHumanReviewUpdatedAt}</div>
                ) : null}
              </div>
            ) : null}

            {exceptionSummary ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
                <div className="font-semibold">Human review summary</div>
                <div className="mt-1">{exceptionSummary.headline}</div>
                {exceptionSummary.details.map((detail) => (
                  <div key={detail} className="mt-1">
                    {detail}
                  </div>
                ))}
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
