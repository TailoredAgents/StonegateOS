"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { TEAM_CARD, TEAM_CARD_PADDED, TEAM_EMPTY_STATE, teamButtonClass } from "./team-ui";
import type { ContactReminderSummary, ContactSummary } from "./contacts.types";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import type { CallCoachingPayload, QueuePayload, ScorecardPayload, TeamMemberPayload } from "./sales.types";

type Props = {
  rangeDays: number;
  memberLabel: string | null;
  trackingStartAt: string | null;
  scorecard: ScorecardPayload | null;
  queue: QueuePayload | null;
  teamMembers: TeamMemberPayload["members"];
  callCoaching: CallCoachingPayload | null;
  error: string | null;
  isOwnerSession: boolean;
};

type QueueKind = "speed_to_lead" | "follow_up";
type QueueItem = QueuePayload["items"][number];

type ContactSummaryResponse = {
  ok: true;
  contact: ContactSummary;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeScore(score: number, weight: number): number {
  if (!weight || !Number.isFinite(weight) || weight <= 0) return 0;
  return clampPercent((score / weight) * 100);
}

function scoreTone(value: number | null): "good" | "warn" | "bad" | "neutral" {
  if (value === null || !Number.isFinite(value)) return "neutral";
  if (value >= 90) return "good";
  if (value >= 80) return "warn";
  return "bad";
}

function Pill({
  tone,
  children
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: React.ReactNode;
}) {
  const classes =
    tone === "good"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : tone === "warn"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : tone === "bad"
          ? "bg-rose-100 text-rose-700 border-rose-200"
          : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${classes}`}>
      {children}
    </span>
  );
}

function ScoreRing({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const stroke = 10;
  const r = 36;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const tone = pct >= 85 ? "#10b981" : pct >= 65 ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative h-24 w-24">
      <svg viewBox="0 0 100 100" className="h-24 w-24">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-semibold text-slate-900">{pct}</div>
          <div className="text-[11px] font-medium text-slate-500">score</div>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function isSystemTask(reminder: ContactReminderSummary): boolean {
  const title = reminder.title?.toLowerCase() ?? "";
  if (title.startsWith("auto:")) return true;
  const notes = reminder.notes ?? "";
  if (notes.includes("[auto]")) return true;
  if (notes.includes("kind=speed_to_lead")) return true;
  if (notes.includes("kind=follow_up")) return true;
  return false;
}

async function readJsonErrorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  if (payload && typeof payload.message === "string" && payload.message.trim().length) return payload.message.trim();
  const text = await response.text().catch(() => "");
  return text.trim().length ? text.trim() : `Request failed (HTTP ${response.status}).`;
}

export function SalesHqClient({
  rangeDays,
  memberLabel,
  trackingStartAt,
  scorecard,
  queue,
  teamMembers,
  callCoaching,
  error,
  isOwnerSession
}: Props): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();

  const allItems = queue?.items ?? [];
  const speedItems = React.useMemo(() => allItems.filter((item) => item.kind === "speed_to_lead"), [allItems]);
  const followupItems = React.useMemo(() => allItems.filter((item) => item.kind === "follow_up"), [allItems]);

  const selectedTaskId = searchParams.get("taskId");
  const selectedKindParam = searchParams.get("queue") as QueueKind | null;
  const [activeQueue, setActiveQueue] = React.useState<QueueKind>(() => (selectedKindParam === "follow_up" ? "follow_up" : "speed_to_lead"));

  const [selectedItem, setSelectedItem] = React.useState<QueueItem | null>(null);
  const [contactSummary, setContactSummary] = React.useState<ContactSummary | null>(null);
  const [contactLoading, setContactLoading] = React.useState(false);
  const [contactError, setContactError] = React.useState<string | null>(null);

  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionBusy, setActionBusy] = React.useState(false);

  React.useEffect(() => {
    if (selectedKindParam === "follow_up" || selectedKindParam === "speed_to_lead") {
      setActiveQueue(selectedKindParam);
    }
  }, [selectedKindParam]);

  React.useEffect(() => {
    const list = activeQueue === "follow_up" ? followupItems : speedItems;
    const found = selectedTaskId ? list.find((item) => item.id === selectedTaskId) : null;
    if (found) {
      setSelectedItem(found);
      return;
    }
    if (list.length > 0) {
      setSelectedItem(list[0] ?? null);
      return;
    }
    setSelectedItem(null);
  }, [activeQueue, followupItems, speedItems, selectedTaskId]);

  React.useEffect(() => {
    async function loadContact() {
      if (!selectedItem) {
        setContactSummary(null);
        return;
      }

      setContactLoading(true);
      setContactError(null);
      try {
        const response = await fetch(`/api/team/contacts/summary?contactId=${encodeURIComponent(selectedItem.contact.id)}`, {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) {
          setContactError(await readJsonErrorMessage(response));
          setContactSummary(null);
          return;
        }
        const data = (await response.json().catch(() => null)) as ContactSummaryResponse | null;
        if (!data || data.ok !== true || !data.contact) {
          setContactError("Unable to load contact.");
          setContactSummary(null);
          return;
        }
        setContactSummary(data.contact);
      } finally {
        setContactLoading(false);
      }
    }

    void loadContact();
  }, [selectedItem]);

  function applySelection(nextQueue: QueueKind, item: QueueItem | null) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "sales-hq");
    params.set("queue", nextQueue);
    if (item) params.set("taskId", item.id);
    else params.delete("taskId");
    router.replace(`/team?${params.toString()}`, { scroll: false });
  }

  async function markContacted(contactId: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/team/sales/touch", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId })
      });
      if (!response.ok) {
        setActionError(await readJsonErrorMessage(response));
        return;
      }
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  async function removeFromSalesHq(contactId: string, disposition: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/team/sales/disposition", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, disposition })
      });
      if (!response.ok) {
        setActionError(await readJsonErrorMessage(response));
        return;
      }
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  async function startCall(contactId: string, taskId: string | null) {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/team/calls/start", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, taskId })
      });
      if (!response.ok) {
        setActionError(await readJsonErrorMessage(response));
        return;
      }
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  async function resetSalesHq() {
    if (actionBusy) return;
    if (!window.confirm("Clear Sales HQ? This only affects the in-app queue; it does not delete contacts.")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/team/sales/reset", {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        setActionError(await readJsonErrorMessage(response));
        return;
      }
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteCoaching(callRecordId: string) {
    if (actionBusy) return;
    if (!window.confirm("Delete this coaching entry?")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/team/calls/coaching/${encodeURIComponent(callRecordId)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        setActionError(await readJsonErrorMessage(response));
        return;
      }
      router.refresh();
    } finally {
      setActionBusy(false);
    }
  }

  const weights = {
    speedToLead: scorecard?.config?.weights?.speedToLead ?? 45,
    followupCompliance: scorecard?.config?.weights?.followupCompliance ?? 35,
    conversion: scorecard?.config?.weights?.conversion ?? 10,
    callQuality: scorecard?.config?.weights?.callQuality ?? 10
  };

  const score = scorecard?.score.total ?? 0;
  const subScores = {
    speedToLead: normalizeScore(scorecard?.score.speedToLead ?? 0, weights.speedToLead),
    followups: normalizeScore(scorecard?.score.followupCompliance ?? 0, weights.followupCompliance),
    conversion: normalizeScore(scorecard?.score.conversion ?? 0, weights.conversion),
    callQuality: normalizeScore(scorecard?.score.callQuality ?? 0, weights.callQuality)
  };

  const manualReminders = React.useMemo(() => {
    const reminders = contactSummary?.reminders ?? [];
    return reminders
      .filter((reminder) => !isSystemTask(reminder))
      .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
  }, [contactSummary?.reminders]);

  const notes = React.useMemo(() => {
    const values = contactSummary?.notes ?? [];
    return [...values].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [contactSummary?.notes]);

  const viewingLabel = memberLabel ? `Viewing: ${memberLabel}` : null;
  const trackingLabel = trackingStartAt ? `Tracking since: ${formatTimestamp(trackingStartAt)}` : null;

  const activeList = activeQueue === "follow_up" ? followupItems : speedItems;

  return (
    <section className={TEAM_CARD_PADDED}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-lg font-semibold text-slate-900">Sales HQ</div>
          <div className="mt-1 text-sm text-slate-600">
            {rangeDays}-day snapshot: speed-to-lead + follow-ups (call-first when a phone exists).
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
            {viewingLabel ? <Pill tone="neutral">{viewingLabel}</Pill> : null}
            {trackingLabel ? <Pill tone="neutral">{trackingLabel}</Pill> : null}
            <Pill tone="neutral">Leads created before this won&apos;t appear in Sales HQ.</Pill>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <ScoreRing value={clampPercent(score)} />
          <div className="space-y-1 text-sm text-slate-700">
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-500">Speed-to-lead</span>
              <span className="font-semibold">{clampPercent(subScores.speedToLead)}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-500">Follow-ups</span>
              <span className="font-semibold">{clampPercent(subScores.followups)}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-500">Conversion</span>
              <span className="font-semibold">{clampPercent(subScores.conversion)}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-500">Call quality</span>
              <span className="font-semibold">{clampPercent(subScores.callQuality)}</span>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
      ) : null}

      {actionError ? (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{actionError}</div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[420px,1fr]">
        <div className={`${TEAM_CARD} p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-900">Queue</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={teamButtonClass(activeQueue === "speed_to_lead" ? "primary" : "secondary", "sm")}
                onClick={() => applySelection("speed_to_lead", speedItems[0] ?? null)}
              >
                Touch within 5 minutes{" "}
                <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold">
                  {speedItems.length}
                </span>
              </button>
              <button
                type="button"
                className={teamButtonClass(activeQueue === "follow_up" ? "primary" : "secondary", "sm")}
                onClick={() => applySelection("follow_up", followupItems[0] ?? null)}
              >
                Follow-ups{" "}
                <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold">
                  {followupItems.length}
                </span>
              </button>
            </div>
          </div>

          <div className="mt-3 text-xs text-slate-600">
            {activeQueue === "speed_to_lead"
              ? "Requires a call attempt within 5 minutes when a phone exists."
              : "On-time = completed by due time + 10 minutes."}
          </div>

          <div className="mt-4 space-y-2">
            {activeList.length === 0 ? (
              <div className={TEAM_EMPTY_STATE}>
                {activeQueue === "speed_to_lead" ? "No active speed-to-lead tasks." : "No follow-ups scheduled yet."}
              </div>
            ) : (
              <div className="max-h-[560px] space-y-2 overflow-auto pr-1">
                {activeList.map((item) => {
                  const selected = selectedItem?.id === item.id;
                  const dueTone = item.overdue ? "bad" : item.minutesUntilDue !== null && item.minutesUntilDue <= 2 ? "warn" : "neutral";
                  const phoneLabel = item.contact.phone ? item.contact.phone : "Phone not on file yet";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => applySelection(activeQueue, item)}
                      className={`w-full rounded-2xl border p-3 text-left transition ${
                        selected ? "border-primary-300 bg-primary-50/40" : "border-slate-200 bg-white hover:border-primary-200"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{item.contact.name}</div>
                          <div className="mt-0.5 truncate text-xs text-slate-600">{phoneLabel}</div>
                          <div className="mt-2 text-xs text-slate-500">{item.title}</div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {item.minutesUntilDue !== null ? (
                            <Pill tone={dueTone}>{item.overdue ? "overdue" : `in ${item.minutesUntilDue}m`}</Pill>
                          ) : (
                            <Pill tone="neutral">unscheduled</Pill>
                          )}
                          {item.contact.serviceAreaStatus === "potentially_out_of_area" ? (
                            <Pill tone="warn">Check ZIP</Pill>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <div className="text-xs text-slate-500">Use the selected task to open the contact and call/message.</div>
            <button type="button" className={teamButtonClass("secondary", "sm")} onClick={resetSalesHq} disabled={!isOwnerSession || actionBusy}>
              Clear Sales HQ
            </button>
          </div>
        </div>

        <div className={`${TEAM_CARD} p-5`}>
          {!selectedItem ? (
            <div className={TEAM_EMPTY_STATE}>Select a queue item to see contact details, notes, and one-click actions.</div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-lg font-semibold text-slate-900">{selectedItem.contact.name}</div>
                    {selectedItem.contact.serviceAreaStatus === "potentially_out_of_area" ? (
                      <Pill tone="warn">Potentially out of area</Pill>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">{selectedItem.contact.phone ?? "Phone not on file yet"}</div>
                  {selectedItem.dueAt ? (
                    <div className="mt-2 text-xs text-slate-500">
                      Due: {formatTimestamp(selectedItem.dueAt)} {selectedItem.overdue ? <Pill tone="bad">overdue</Pill> : null}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-slate-500">No due time set yet.</div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={teamButtonClass("primary", "sm")}
                    onClick={() => {
                      const label = selectedItem.contact.phone ?? "this contact";
                      if (!window.confirm(`Call ${selectedItem.contact.name} (${label}) from the Stonegate number?`)) return;
                      void startCall(selectedItem.contact.id, selectedItem.id);
                    }}
                    disabled={actionBusy || !selectedItem.contact.phone}
                    title={selectedItem.contact.phone ? "" : "Phone not on file"}
                  >
                    Call
                  </button>
                  <a className={teamButtonClass("secondary", "sm")} href={`/team?tab=inbox&contactId=${encodeURIComponent(selectedItem.contact.id)}`}>
                    Message
                  </a>
                  <a className={teamButtonClass("secondary", "sm")} href={`/team?tab=contacts&contactId=${encodeURIComponent(selectedItem.contact.id)}`}>
                    Open contact
                  </a>
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Task</div>
                <div className="font-semibold text-slate-900">{selectedItem.title}</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={teamButtonClass("secondary", "sm")}
                    onClick={() => void markContacted(selectedItem.contact.id)}
                    disabled={actionBusy}
                  >
                    Mark contacted
                  </button>
                  <details className="relative">
                    <summary className={teamButtonClass("secondary", "sm")}>Remove</summary>
                    <div className="absolute right-0 z-10 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl shadow-slate-200/60">
                      <div className="text-xs font-semibold text-slate-700">Remove from Sales HQ</div>
                      <div className="mt-2 grid gap-2">
                        {["spam", "not_a_lead", "out_of_state", "out_of_area", "bad_phone", "duplicate", "handled", "do_not_contact"].map(
                          (value) => (
                            <button
                              key={value}
                              type="button"
                              className={teamButtonClass("danger", "sm")}
                              onClick={() => void removeFromSalesHq(selectedItem.contact.id, value)}
                              disabled={actionBusy}
                            >
                              {value.replace(/_/g, " ")}
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  </details>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reminders</div>
                  {contactLoading ? (
                    <div className={TEAM_EMPTY_STATE}>Loading reminders...</div>
                  ) : contactError ? (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{contactError}</div>
                  ) : contactSummary ? (
                    <InboxContactRemindersClient contactId={contactSummary.id} initialReminders={manualReminders} />
                  ) : (
                    <div className={TEAM_EMPTY_STATE}>No contact selected.</div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</div>
                  {contactLoading ? (
                    <div className={TEAM_EMPTY_STATE}>Loading notes...</div>
                  ) : contactError ? (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{contactError}</div>
                  ) : contactSummary ? (
                    <InboxContactNotesClient contactId={contactSummary.id} initialNotes={notes} />
                  ) : (
                    <div className={TEAM_EMPTY_STATE}>No contact selected.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">Call coaching</div>
            <div className="mt-1 text-xs text-slate-600">
              Primary score matches call type (inbound lead vs outbound cold outreach). Expand a call to see the other score.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={scoreTone(callCoaching?.summary.inbound.avgScore ?? null)}>
              Inbound avg: {callCoaching?.summary.inbound.avgScore ?? "—"} ({callCoaching?.summary.inbound.count ?? 0})
            </Pill>
            <Pill tone={scoreTone(callCoaching?.summary.outbound.avgScore ?? null)}>
              Outbound avg: {callCoaching?.summary.outbound.avgScore ?? "—"} ({callCoaching?.summary.outbound.count ?? 0})
            </Pill>
          </div>
        </div>

        <div className={`mt-4 ${TEAM_CARD} p-4`}>
          {!callCoaching || callCoaching.items.length === 0 ? (
            <div className={TEAM_EMPTY_STATE}>
              No calls scored yet. Make an inbound or outbound call, then wait ~1–2 minutes for the outbox worker to process and score it.
            </div>
          ) : (
            <div className="space-y-3">
              {callCoaching.items.slice(0, 25).map((item) => {
                const title = item.contact.name || "Unknown caller";
                const when = formatTimestamp(item.createdAt);
                const duration = item.durationSec ? `${item.durationSec}s` : "—";
                const inboundScore = item.primary?.rubric === "inbound" ? item.primary.scoreOverall : item.secondary?.rubric === "inbound" ? item.secondary.scoreOverall : null;
                const outboundScore = item.primary?.rubric === "outbound" ? item.primary.scoreOverall : item.secondary?.rubric === "outbound" ? item.secondary.scoreOverall : null;
                return (
                  <details key={item.callRecordId} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <summary className="flex cursor-pointer list-none flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">{title}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {when} • {duration}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={scoreTone(inboundScore)}>
                          Inbound: {inboundScore === null ? "—" : inboundScore}
                        </Pill>
                        <Pill tone={scoreTone(outboundScore)}>
                          Outbound: {outboundScore === null ? "—" : outboundScore}
                        </Pill>
                        {isOwnerSession ? (
                          <button
                            type="button"
                            className={teamButtonClass("danger", "sm")}
                            onClick={(event) => {
                              event.preventDefault();
                              void deleteCoaching(item.callRecordId);
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </summary>

                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <div className="space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Primary ({item.primaryRubric})</div>
                        {item.primary ? (
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                            <div className="font-semibold text-slate-900">Wins</div>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                              {item.primary.wins.slice(0, 6).map((line, idx) => (
                                <li key={idx}>{line}</li>
                              ))}
                            </ul>
                            {item.primary.improvements.length ? (
                              <>
                                <div className="mt-4 font-semibold text-slate-900">Next time</div>
                                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                                  {item.primary.improvements.slice(0, 6).map((line, idx) => (
                                    <li key={idx}>{line}</li>
                                  ))}
                                </ul>
                              </>
                            ) : null}
                          </div>
                        ) : (
                          <div className={TEAM_EMPTY_STATE}>No coaching data.</div>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Secondary</div>
                        {item.secondary ? (
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                            <div className="font-semibold text-slate-900">Wins</div>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                              {item.secondary.wins.slice(0, 6).map((line, idx) => (
                                <li key={idx}>{line}</li>
                              ))}
                            </ul>
                            {item.secondary.improvements.length ? (
                              <>
                                <div className="mt-4 font-semibold text-slate-900">Next time</div>
                                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                                  {item.secondary.improvements.slice(0, 6).map((line, idx) => (
                                    <li key={idx}>{line}</li>
                                  ))}
                                </ul>
                              </>
                            ) : null}
                          </div>
                        ) : (
                          <div className={TEAM_EMPTY_STATE}>No secondary rubric for this call.</div>
                        )}

                        {item.note?.body ? (
                          <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Call notes</div>
                            <div className="mt-2 whitespace-pre-wrap">{item.note.body}</div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
