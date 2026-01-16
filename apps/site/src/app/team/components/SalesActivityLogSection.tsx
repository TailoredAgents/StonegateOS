import React from "react";
import { callAdminApi } from "../lib/api";

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

function summarizeMeta(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  const keys = ["contactId", "threadId", "channel", "to", "from", "taskId", "leadId", "appointmentId"];
  const parts: string[] = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      const value = meta[key];
      if (value === null || value === undefined) continue;
      parts.push(`${key}: ${String(value)}`);
    }
  }
  if (parts.length) return parts.join(" • ");
  const entries = Object.entries(meta).slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`);
  return entries.length ? entries.join(" • ") : null;
}

export async function SalesActivityLogSection({
  memberId
}: {
  memberId?: string;
}): Promise<React.ReactElement> {
  const qs = new URLSearchParams({ limit: "80", rangeDays: "7" });
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

  let members: TeamMember[] = [];
  if (membersRes.ok) {
    const membersPayload = (await membersRes.json()) as { members?: TeamMember[] };
    members = membersPayload.members ?? [];
  }

  const selectedMemberId = (typeof activityPayload.memberId === "string" ? activityPayload.memberId : null) ?? null;
  const selectedLabel = selectedMemberId ? members.find((m) => m.id === selectedMemberId)?.name ?? null : null;

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Sales Activity Log</h2>
            <p className="mt-1 text-sm text-slate-600">
              Owner view of calls, messages, follow-ups, and automation actions.
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

      {events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-5 text-sm text-slate-500 shadow-sm">
          No recent sales activity.
        </div>
      ) : (
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <ul className="divide-y divide-slate-200">
            {events.map((event) => {
              const actorLabel = event.actor?.name ?? event.actor?.label ?? event.actor?.type ?? "system";
              const metaLine = summarizeMeta(event.meta);
              return (
                <li key={event.id} className="py-4 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      {event.action}
                    </span>
                    <span className="text-xs text-slate-500">{formatAgo(event.createdAt)}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium text-slate-900">
                    {actorLabel}
                    {" -> "}
                    {event.entityType}
                    {event.entityId ? ` (${event.entityId})` : ""}
                  </div>
                  {metaLine ? <div className="mt-1 text-xs text-slate-500">{metaLine}</div> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

