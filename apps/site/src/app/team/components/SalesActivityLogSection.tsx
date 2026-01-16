import React from "react";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE, formatDayKey } from "../lib/timezone";

type TeamMember = { id: string; name: string; active: boolean };

type ActivityEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  actor?: {
    type?: string;
    id?: string | null;
    role?: string | null;
    label?: string | null;
    name?: string | null;
  };
  meta?: Record<string, unknown> | null;
};

type ActivityRow = {
  id: string;
  whenIso: string;
  whenLocal: string;
  ago: string;
  actor: string;
  type: "Outbound call" | "Inbound message" | "Outbound message" | "Autopilot draft" | "Reminder" | "Other";
  channel: string | null;
  contactId: string | null;
  leadId: string | null;
  summary: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function formatAgo(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "just now";
  const diff = Date.now() - value.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatLocal(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(value);
}

function getMetaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!meta) return null;
  const value = meta[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getMetaUuid(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = getMetaString(meta, key);
  if (!value) return null;
  return isUuid(value) ? value : null;
}

function buildRow(event: ActivityEvent): ActivityRow {
  const actor = event.actor?.name ?? event.actor?.label ?? event.actor?.type ?? "system";
  const ago = formatAgo(event.createdAt);
  const whenLocal = formatLocal(event.createdAt);

  const contactId =
    getMetaUuid(event.meta, "contactId") ?? (event.entityType === "contact" && event.entityId ? event.entityId : null);
  const leadId = getMetaUuid(event.meta, "leadId") ?? null;
  const channel = getMetaString(event.meta, "channel") ?? getMetaString(event.meta, "replyChannel") ?? null;

  const to = getMetaString(event.meta, "to");
  const from = getMetaString(event.meta, "from");

  if (event.action === "call.started" || event.action.startsWith("sales.escalation.call.")) {
    const target = to ?? "unknown number";
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type: "Outbound call",
      channel: "voice",
      contactId,
      leadId,
      summary:
        event.action === "sales.escalation.call.connected"
          ? `Connected (press 1) to ${target}`
          : event.action === "sales.escalation.call.started"
            ? `Auto call started to ${target}`
            : `Call started to ${target}`
    };
  }

  if (event.action === "message.received" || event.action === "message.queued") {
    const directionLabel = event.action === "message.received" ? "Inbound message" : "Outbound message";
    const type = event.action === "message.received" ? "Inbound message" : "Outbound message";
    const channelLabel = channel ?? "unknown";
    const numberLabel = to ?? from ?? null;
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type,
      channel: channelLabel,
      contactId,
      leadId,
      summary: numberLabel ? `${directionLabel} (${channelLabel}) to or from ${numberLabel}` : `${directionLabel} (${channelLabel})`
    };
  }

  if (event.action.startsWith("sales.autopilot.")) {
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type: "Autopilot draft",
      channel: channel ?? null,
      contactId,
      leadId,
      summary: event.action === "sales.autopilot.draft_created" ? "Draft created" : event.action
    };
  }

  if (event.action.startsWith("crm.reminder.")) {
    const taskId = getMetaString(event.meta, "taskId");
    const recipient = to ?? getMetaString(event.meta, "recipient");
    const detail = [taskId ? `task ${taskId}` : null, recipient ? `to ${recipient}` : null].filter(Boolean).join(" • ");
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type: "Reminder",
      channel: "sms",
      contactId,
      leadId,
      summary: detail ? `${event.action} • ${detail}` : event.action
    };
  }

  return {
    id: event.id,
    whenIso: event.createdAt,
    whenLocal,
    ago,
    actor,
    type: "Other",
    channel: channel ?? null,
    contactId,
    leadId,
    summary: event.action
  };
}

export async function SalesActivityLogSection({ memberId }: { memberId?: string }): Promise<React.ReactElement> {
  const qs = new URLSearchParams({ limit: "150", rangeDays: "7" });
  if (memberId) qs.set("memberId", memberId);

  const [activityRes, membersRes] = await Promise.all([
    callAdminApi(`/api/admin/sales/activity?${qs.toString()}`),
    callAdminApi("/api/admin/team/members")
  ]);

  if (!activityRes.ok) {
    throw new Error("Failed to load sales activity");
  }

  const activityPayload = (await activityRes.json()) as { events?: ActivityEvent[]; memberId?: string | null };
  const events = activityPayload.events ?? [];
  const rows = events.map(buildRow);

  let members: TeamMember[] = [];
  if (membersRes.ok) {
    const membersPayload = (await membersRes.json()) as { members?: TeamMember[] };
    members = membersPayload.members ?? [];
  }

  const selectedMemberId = (typeof activityPayload.memberId === "string" ? activityPayload.memberId : null) ?? null;
  const selectedLabel = selectedMemberId ? members.find((m) => m.id === selectedMemberId)?.name ?? null : null;

  const summary = rows.reduce(
    (acc, row) => {
      if (row.type === "Outbound call") acc.outboundCalls += 1;
      if (row.type === "Outbound message") acc.outboundMessages += 1;
      if (row.type === "Inbound message") acc.inboundMessages += 1;
      if (row.type === "Autopilot draft") acc.autopilotDrafts += 1;
      if (row.type === "Reminder") acc.reminders += 1;
      return acc;
    },
    { outboundCalls: 0, outboundMessages: 0, inboundMessages: 0, autopilotDrafts: 0, reminders: 0 }
  );

  const grouped = rows.reduce<Record<string, ActivityRow[]>>((acc, row) => {
    const dayKey = formatDayKey(new Date(row.whenIso));
    acc[dayKey] ??= [];
    acc[dayKey].push(row);
    return acc;
  }, {});

  const groupKeys = Object.keys(grouped).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Sales Activity Log</h2>
            <p className="mt-1 text-sm text-slate-600">
              Readable feed of when calls and messages happened, plus reminders and autopilot activity.
            </p>
            {selectedLabel ? (
              <p className="mt-2 text-xs text-slate-500">
                Filtered to: <span className="font-semibold text-slate-700">{selectedLabel}</span>
              </p>
            ) : null}
          </div>

          <form method="GET" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="sales-log" />
            <label className="text-xs font-semibold text-slate-700">
              Team member
              <select
                name="memberId"
                defaultValue={selectedMemberId ?? ""}
                className="mt-1 block w-56 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              >
                <option value="">All</option>
                {members
                  .filter((member) => member.active)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700"
            >
              Apply
            </button>
          </form>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-5">
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Outbound calls</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{summary.outboundCalls}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Outbound messages</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{summary.outboundMessages}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Inbound messages</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{summary.inboundMessages}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Autopilot drafts</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{summary.autopilotDrafts}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Reminders</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{summary.reminders}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-5 text-sm text-slate-500 shadow-sm">
          No recent sales activity.
        </div>
      ) : (
        <div className="space-y-4">
          {groupKeys.map((dayKey) => {
            const dayRows = grouped[dayKey] ?? [];
            const daySummary = dayRows.reduce(
              (acc, row) => {
                if (row.type === "Outbound call") acc.calls += 1;
                if (row.type === "Outbound message") acc.outbound += 1;
                if (row.type === "Inbound message") acc.inbound += 1;
                return acc;
              },
              { calls: 0, outbound: 0, inbound: 0 }
            );

            return (
              <div key={dayKey} className="rounded-3xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/50 backdrop-blur">
                <div className="flex flex-col gap-2 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-semibold text-slate-900">{dayKey}</div>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">Calls: {daySummary.calls}</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">Outbound: {daySummary.outbound}</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">Inbound: {daySummary.inbound}</span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <tr>
                        <th className="whitespace-nowrap px-4 py-3">When</th>
                        <th className="whitespace-nowrap px-4 py-3">Type</th>
                        <th className="whitespace-nowrap px-4 py-3">Channel</th>
                        <th className="whitespace-nowrap px-4 py-3">Contact</th>
                        <th className="px-4 py-3">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {dayRows.map((row) => (
                        <tr key={row.id} className="text-slate-700">
                          <td className="whitespace-nowrap px-4 py-3">
                            <div className="font-medium text-slate-900">{row.whenLocal}</div>
                            <div className="text-xs text-slate-500">{row.ago}</div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                              {row.type}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600">{row.channel ?? "—"}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs">
                            {row.contactId ? (
                              <a
                                className="font-semibold text-primary-700 hover:text-primary-800"
                                href={`/team?tab=contacts&contactId=${encodeURIComponent(row.contactId)}`}
                              >
                                Open
                              </a>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">{row.summary}</div>
                            <div className="mt-1 text-xs text-slate-500">Actor: {row.actor}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

