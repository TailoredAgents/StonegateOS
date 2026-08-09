import React from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  parseTeamSalesActivityPayload,
  type TeamSalesActivityEvent,
  type TeamSalesActivityPage,
} from "../sales-activity-page";
import { TEAM_TIME_ZONE, formatDayKey } from "../lib/timezone";
import { teamSurfaceHref } from "../surface-registry";
import type { SalesSupervisorPayload } from "./sales.types";

type TeamMember = { id: string; name: string; active: boolean };

type ActivityRow = {
  id: string;
  whenIso: string;
  whenLocal: string;
  ago: string;
  actor: string;
  type:
    | "Outbound call"
    | "Inbound message"
    | "Outbound message"
    | "Agent draft"
    | "Agent autosend"
    | "Reminder"
    | "Other";
  channel: string | null;
  contactId: string | null;
  leadId: string | null;
  threadId: string | null;
  callRecordId: string | null;
  summary: string;
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

function formatLocal(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function buildRow(event: TeamSalesActivityEvent): ActivityRow {
  const actor =
    event.actor?.name ?? event.actor?.label ?? event.actor?.type ?? "system";
  const ago = formatAgo(event.createdAt);
  const whenLocal = formatLocal(event.createdAt);

  const contactId = event.context?.contactId ?? null;
  const leadId = event.context?.leadId ?? null;
  const threadId = event.context?.threadId ?? null;
  const callRecordId = event.context?.callRecordId ?? null;
  const channel = event.context?.channel ?? null;
  const actionType = event.context?.actionType ?? null;

  if (
    event.action === "call.started" ||
    event.action.startsWith("sales.escalation.call.")
  ) {
    const escalationSummary: Record<string, string> = {
      "sales.escalation.call.started": "Automated call started",
      "sales.escalation.call.dispatched": "Automated call dispatch started",
      "sales.escalation.call.connected": "Customer connection confirmed",
      "sales.escalation.call.not_connected": "Customer was not connected",
      "sales.escalation.call.not_dispatched": "Automated call was not placed",
      "sales.escalation.call.reconciliation_required":
        "Call result needs reconciliation",
    };
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
      threadId,
      callRecordId,
      summary:
        escalationSummary[event.action] ??
        (event.context?.terminalOutcome === "connected"
          ? "Customer connection confirmed"
          : "Outbound call activity recorded"),
    };
  }

  if (
    event.action === "message.received" ||
    event.action === "message.queued"
  ) {
    const directionLabel =
      event.action === "message.received"
        ? "Inbound message"
        : "Outbound message";
    const type =
      event.action === "message.received"
        ? "Inbound message"
        : "Outbound message";
    const channelLabel = channel ?? "unknown";
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
      threadId,
      callRecordId,
      summary: `${directionLabel} (${channelLabel})`,
    };
  }

  if (
    event.action.startsWith("sales.autopilot.") ||
    event.action.startsWith("sales.agent.draft.")
  ) {
    const summary =
      event.action === "sales.autopilot.draft_created"
        ? "Autopilot draft created"
        : event.action === "sales.agent.draft.prepared"
          ? actionType
            ? `Planner draft prepared for ${actionType}`
            : "Planner draft prepared"
          : event.action === "sales.agent.draft.reused"
            ? actionType
              ? `Planner draft reused for ${actionType}`
              : "Planner draft reused"
            : event.action === "sales.agent.draft.skipped"
              ? "Planner draft skipped"
              : event.action;
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type: "Agent draft",
      channel: channel ?? null,
      contactId,
      leadId,
      threadId,
      callRecordId,
      summary,
    };
  }

  if (
    event.action === "message.retry" ||
    event.action.startsWith("sales.agent.autosend.")
  ) {
    const summary =
      event.action === "sales.agent.autosend.queued"
        ? actionType
          ? `Planner autosend queued for ${actionType}`
          : "Planner autosend queued"
        : event.action === "sales.agent.autosend.skipped"
          ? "Planner autosend skipped"
          : "Queued send";
    return {
      id: event.id,
      whenIso: event.createdAt,
      whenLocal,
      ago,
      actor,
      type: "Agent autosend",
      channel: channel ?? null,
      contactId,
      leadId,
      threadId,
      callRecordId,
      summary,
    };
  }

  if (event.action.startsWith("crm.reminder.")) {
    const summary =
      event.action === "crm.reminder.created"
        ? "Reminder created"
        : event.action === "crm.reminder.updated"
          ? "Reminder updated"
          : event.action === "crm.reminder.completed"
            ? "Reminder completed"
            : event.action === "crm.reminder.sent"
              ? "Reminder sent"
              : event.action === "crm.reminder.failed"
                ? "Reminder delivery failed"
                : "Reminder activity recorded";
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
      threadId,
      callRecordId,
      summary,
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
    threadId,
    callRecordId,
    summary: event.action,
  };
}

function ActivityContextLinks({
  row,
  compact = false,
}: {
  row: ActivityRow;
  compact?: boolean;
}): React.ReactElement | null {
  const linkClass = compact
    ? "inline-flex min-h-[44px] items-center rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-xs font-semibold text-[color:var(--team-link)]"
    : "inline-flex min-h-[44px] items-center font-semibold text-[color:var(--team-link)] hover:underline";
  const links: React.ReactElement[] = [];

  if (row.contactId) {
    links.push(
      <a
        key="contact"
        className={linkClass}
        href={teamSurfaceHref("contacts", {
          query: { contactId: row.contactId },
        })}
      >
        Contact
      </a>,
    );
  }
  if (row.threadId) {
    links.push(
      <a
        key="thread"
        className={linkClass}
        href={teamSurfaceHref("inbox", {
          query: { threadId: row.threadId },
        })}
      >
        Conversation
      </a>,
    );
  }
  if (row.callRecordId) {
    links.push(
      <a
        key="call"
        className={linkClass}
        href={`${teamSurfaceHref("sales-hq")}#call-${row.callRecordId}`}
      >
        Call coaching
      </a>,
    );
  }

  return links.length > 0 ? (
    <div className="flex flex-wrap gap-2" aria-label="Related CRM records">
      {links}
    </div>
  ) : null;
}

function formatPercent(value: number | null | undefined): string {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${Math.round(numeric * 100)}%`;
}

function formatTouchKindLabel(
  value: SalesSupervisorPayload["appointmentPreservation"]["strongestTouchKind"],
): string | null {
  if (!value) return null;
  if (value === "requested") return "Initial confirmation";
  if (value === "rescheduled") return "Reschedule confirmation";
  if (value === "reminder") return "Reminder";
  return "Other";
}

function formatCloseLoopCount(value: number): string {
  return `${value}`;
}

function SalesHqViewsNav(): React.ReactElement {
  const salesHqHref = teamSurfaceHref("sales-hq");
  return (
    <nav
      aria-label="Sales HQ views"
      className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
    >
      <a
        href={`${salesHqHref}#sales-hq-queue`}
        className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
      >
        Queue
      </a>
      <a
        href={`${salesHqHref}#sales-hq-coaching`}
        className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
      >
        Coaching
      </a>
      <a
        href={teamSurfaceHref("sales-log")}
        aria-current="page"
        className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
      >
        Activity
      </a>
    </nav>
  );
}

type ActivitySearchValue = string | string[] | undefined;

function appendActivitySearchValue(
  params: URLSearchParams,
  key: string,
  value: ActivitySearchValue,
  fallback?: string,
): void {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? fallback === undefined
        ? []
        : [fallback]
      : [value];
  for (const item of values) params.append(key, item);
}

export async function SalesActivityLogSection({
  memberId,
  cursor,
  limit,
  rangeDays,
  actions,
}: {
  memberId?: string;
  cursor?: ActivitySearchValue;
  limit?: ActivitySearchValue;
  rangeDays?: ActivitySearchValue;
  actions?: ActivitySearchValue;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const qs = new URLSearchParams();
  appendActivitySearchValue(qs, "limit", limit, "50");
  appendActivitySearchValue(qs, "rangeDays", rangeDays, "7");
  appendActivitySearchValue(qs, "actions", actions);
  appendActivitySearchValue(qs, "cursor", cursor);
  if (memberId) qs.set("memberId", memberId);

  type ActivityPayload = NonNullable<
    ReturnType<typeof parseTeamSalesActivityPayload>
  > & {
    supervisor: SalesSupervisorPayload;
  };
  let activityPayload: ActivityPayload | null = null;
  let activityError: string | null = null;
  let membersError: string | null = null;
  let members: TeamMember[] = [];
  const [activityResult, membersResult] = await Promise.allSettled([
    callAdminApiAs(principal, `/api/admin/sales/activity?${qs.toString()}`),
    callAdminApiAs(principal, "/api/admin/team/members"),
  ]);

  if (activityResult.status === "fulfilled") {
    const activityRes = activityResult.value;
    if (activityRes.ok) {
      try {
        const payload: unknown = await activityRes.json();
        const parsedPayload = parseTeamSalesActivityPayload(payload);
        if (parsedPayload) {
          activityPayload = {
            ...parsedPayload,
            supervisor:
              parsedPayload.supervisor as unknown as SalesSupervisorPayload,
          };
        } else {
          activityError =
            "Sales activity returned an incomplete or unsafe response. This is not an empty history.";
        }
      } catch {
        activityError =
          "Sales activity returned malformed data. This is not an empty history.";
      }
    } else if (activityRes.status === 409) {
      activityError =
        "This saved activity page changed while it was open. Return to the newest activity to create a fresh snapshot.";
    } else if (activityRes.status === 422) {
      activityError =
        "This activity page link has invalid or mismatched filters. Return to the newest activity and apply the filters again.";
    } else {
      activityError = `Sales activity is unavailable (HTTP ${activityRes.status}).`;
    }
  } else {
    activityError =
      "Sales activity is unavailable because the service could not be reached.";
  }

  if (membersResult.status === "fulfilled") {
    const membersRes = membersResult.value;
    if (membersRes.ok) {
      try {
        const membersPayload: unknown = await membersRes.json();
        if (
          membersPayload &&
          typeof membersPayload === "object" &&
          Array.isArray((membersPayload as { members?: unknown }).members)
        ) {
          members = (membersPayload as { members: TeamMember[] }).members;
        } else {
          membersError = "Team-member filters returned an incomplete response.";
        }
      } catch {
        membersError = "Team-member filters returned malformed data.";
      }
    } else {
      membersError = `Team-member filters are unavailable (HTTP ${membersRes.status}).`;
    }
  } else {
    membersError = "Team-member filters are unavailable.";
  }

  if (activityError || !activityPayload) {
    const recoveryHref = teamSurfaceHref("sales-log", {
      query: {
        memberId,
        salesRangeDays: typeof rangeDays === "string" ? rangeDays : undefined,
        salesActions: typeof actions === "string" ? actions : undefined,
        salesLimit: typeof limit === "string" ? limit : undefined,
      },
    });
    return (
      <section className="space-y-6">
        <SalesHqViewsNav />
        <div
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800"
          role="alert"
        >
          <p className="font-semibold">Sales Activity could not be loaded.</p>
          <p className="mt-1">
            {activityError ?? "The response was incomplete."}
          </p>
          <p className="mt-1">
            This is not an empty activity history. Refresh to retry.
          </p>
          <a
            href={recoveryHref}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-xl border border-rose-300 bg-white px-4 py-2 font-semibold text-rose-900"
          >
            Return to newest activity
          </a>
        </div>
      </section>
    );
  }

  const events = activityPayload.events;
  const supervisor = activityPayload.supervisor;
  const page: TeamSalesActivityPage = activityPayload.page;
  const rows = events.map(buildRow);

  const selectedMemberId = activityPayload.memberId;
  const selectedLabel = selectedMemberId
    ? (members.find((m) => m.id === selectedMemberId)?.name ?? null)
    : null;
  const pageHref = (nextCursor: string | null) =>
    teamSurfaceHref("sales-log", {
      query: {
        memberId: selectedMemberId,
        salesRangeDays: activityPayload.rangeDays,
        salesActions: activityPayload.actions.join(","),
        salesLimit: page.limit,
        salesCursor: nextCursor,
      },
    });
  const newestHref = pageHref(null);

  const summary = rows.reduce(
    (acc, row) => {
      if (row.type === "Outbound call") acc.outboundCalls += 1;
      if (row.type === "Outbound message") acc.outboundMessages += 1;
      if (row.type === "Inbound message") acc.inboundMessages += 1;
      if (row.type === "Agent draft") acc.agentDrafts += 1;
      if (row.type === "Agent autosend") acc.agentAutosends += 1;
      if (row.type === "Reminder") acc.reminders += 1;
      return acc;
    },
    {
      outboundCalls: 0,
      outboundMessages: 0,
      inboundMessages: 0,
      agentDrafts: 0,
      agentAutosends: 0,
      reminders: 0,
    },
  );

  const grouped = rows.reduce<Record<string, ActivityRow[]>>((acc, row) => {
    const dayKey = formatDayKey(new Date(row.whenIso));
    acc[dayKey] ??= [];
    acc[dayKey].push(row);
    return acc;
  }, {});

  const groupKeys = Object.keys(grouped).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const exportParams = new URLSearchParams({
    rangeDays: String(activityPayload.rangeDays),
    actions: activityPayload.actions.join(","),
  });
  if (selectedMemberId) exportParams.set("memberId", selectedMemberId);
  const exportHref = `/api/team/sales/activity/export?${exportParams.toString()}`;

  return (
    <section className="space-y-6">
      <SalesHqViewsNav />
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              Sales Activity Log
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Readable feed of when calls and messages happened, plus reminders
              and agent activity.
            </p>
            {selectedLabel ? (
              <p className="mt-2 text-xs text-slate-500">
                Filtered to:{" "}
                <span className="font-semibold text-slate-700">
                  {selectedLabel}
                </span>
              </p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">
              Snapshot taken{" "}
              <time dateTime={page.asOf}>{formatLocal(page.asOf)}</time>. New
              activity appears after you return to newest.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <form
              method="GET"
              action={teamSurfaceHref("sales-log")}
              className="flex flex-wrap items-end gap-2"
            >
              <input
                type="hidden"
                name="salesActions"
                value={activityPayload.actions.join(",")}
              />
              <input
                type="hidden"
                name="salesLimit"
                value={String(page.limit)}
              />
              <label className="text-xs font-semibold text-slate-700">
                Team member
                <select
                  name="memberId"
                  defaultValue={selectedMemberId ?? ""}
                  className="mt-1 block min-h-[44px] w-56 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
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
              <label className="text-xs font-semibold text-slate-700">
                Time window
                <select
                  name="salesRangeDays"
                  defaultValue={String(activityPayload.rangeDays)}
                  className="mt-1 block min-h-[44px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                >
                  {[1, 7, 14, 30, 90].includes(
                    activityPayload.rangeDays,
                  ) ? null : (
                    <option value={String(activityPayload.rangeDays)}>
                      {activityPayload.rangeDays} days
                    </option>
                  )}
                  <option value="1">24 hours</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </label>
              <button
                type="submit"
                className="min-h-[44px] rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700"
              >
                Apply
              </button>
            </form>
            {hasTeamPermission(principal, "audit.export") ? (
              <a
                href={exportHref}
                download
                className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:border-primary-300 hover:text-primary-800"
              >
                Export redacted CSV
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <summary className="cursor-pointer font-semibold text-slate-900">
          What this activity view counts
        </summary>
        <p className="mt-2">
          This {activityPayload.rangeDays}-day feed counts recorded sales calls,
          inbound and outbound messages, agent draft/autosend events, and
          reminder events. The summary cards count only the events on the
          current page. Page totals are fixed to the snapshot taken when this
          browsing sequence began, so new activity cannot shift or duplicate
          older pages.
        </p>
      </details>

      {membersError ? (
        <div
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          role="status"
        >
          {membersError} Activity data is still available; the member filter may
          be incomplete.
        </div>
      ) : null}

      {supervisor ? (
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Supervisor Overview
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Fast read on what the agent handled automatically, what it held
                back, and where follow-up performance is helping or hurting.
              </p>
            </div>
            <div className="text-xs text-slate-500">
              Last {selectedLabel ? "filtered" : "team-wide"}{" "}
              {qs.get("rangeDays")} days
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Held Back
              </p>
              <p className="mt-2 text-2xl font-semibold text-amber-950">
                {supervisor.activeHumanReviewCount}
              </p>
              <p className="mt-2 text-sm text-amber-900">
                Need human review right now
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Reviewed in last 24h: {supervisor.recentlyReviewedCount}
              </p>
              {supervisor.topHoldReasons.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {supervisor.topHoldReasons.map((item) => (
                    <span
                      key={item.label}
                      className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900"
                    >
                      {item.label}: {item.count}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Agent Handled
              </p>
              <p className="mt-2 text-2xl font-semibold text-emerald-950">
                {supervisor.agentAutosendCount}
              </p>
              <p className="mt-2 text-sm text-emerald-900">
                Autosends queued this period
              </p>
              <p className="mt-1 text-xs text-emerald-800">
                Drafts prepared/reused: {supervisor.agentDraftCount}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/90 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Quote Close
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {formatPercent(supervisor.quoteClose.bookRate)}
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Booked after quote follow-up
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Lost: {formatPercent(supervisor.quoteClose.lostRate)}
                {supervisor.quoteClose.preferredChannel
                  ? ` | Lean: ${supervisor.quoteClose.preferredChannel.toUpperCase()}`
                  : ""}
              </p>
              {supervisor.quoteClose.keepSofter ? (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  Recent close pushes are running hot. Softer nudges are safer
                  right now.
                </p>
              ) : null}
              {supervisor.topLostReasons.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {supervisor.topLostReasons.map((item) => (
                    <span
                      key={item.label}
                      className="rounded-full bg-rose-100 px-2.5 py-1 text-[11px] font-semibold text-rose-700"
                    >
                      Lost: {item.label} ({item.count})
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/90 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Objection Saves
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {formatPercent(supervisor.objectionSave.reopenRate)}
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Reopened after objection follow-up
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Booked later: {formatPercent(supervisor.objectionSave.bookRate)}
                {supervisor.objectionSave.preferredChannel
                  ? ` | Lean: ${supervisor.objectionSave.preferredChannel.toUpperCase()}`
                  : ""}
              </p>
              {supervisor.objectionSave.keepSofter ? (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  Objection saves are softening. Lower-pressure follow-ups are
                  winning more.
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/90 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Booked Revenue Protection
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {formatPercent(
                  supervisor.appointmentPreservation.completedRate,
                )}
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Completed after confirmation touches
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Cancel/no-show:{" "}
                {formatPercent(
                  supervisor.appointmentPreservation.canceledRate +
                    supervisor.appointmentPreservation.noShowRate,
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Strongest touch:{" "}
                {formatTouchKindLabel(
                  supervisor.appointmentPreservation.strongestTouchKind,
                ) ?? "Still learning"}
              </p>
              {supervisor.appointmentPreservation.needsHumanBackup ? (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  Booked jobs are slipping. Human backup is recommended on shaky
                  appointments.
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-800">
                  Close-loop handling
                </div>
                <div className="mt-1 text-sm text-sky-950">
                  Pre-appointment, booked-job support, and post-job follow-up
                  volume on the agent stack.
                </div>
              </div>
              <div className="text-xs text-sky-800">
                Total handled:{" "}
                {formatCloseLoopCount(supervisor.closeLoopActivity.total)}
              </div>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-sky-200 bg-white/80 p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Pre-appointment
                </div>
                <div className="mt-2 text-2xl font-semibold text-sky-950">
                  {formatCloseLoopCount(
                    supervisor.closeLoopActivity.preAppointmentCount,
                  )}
                </div>
                <div className="mt-1 text-xs text-sky-800">
                  Check-ins queued or drafted
                </div>
              </div>
              <div className="rounded-2xl border border-sky-200 bg-white/80 p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Booked-job support
                </div>
                <div className="mt-2 text-2xl font-semibold text-sky-950">
                  {formatCloseLoopCount(
                    supervisor.closeLoopActivity.bookedSupportCount,
                  )}
                </div>
                <div className="mt-1 text-xs text-sky-800">
                  Timing, reassurance, or reschedule-save replies
                </div>
              </div>
              <div className="rounded-2xl border border-sky-200 bg-white/80 p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Post-job
                </div>
                <div className="mt-2 text-2xl font-semibold text-sky-950">
                  {formatCloseLoopCount(
                    supervisor.closeLoopActivity.postJobCount,
                  )}
                </div>
                <div className="mt-1 text-xs text-sky-800">
                  Satisfaction follow-ups after completion
                </div>
              </div>
              <div className="rounded-2xl border border-sky-200 bg-white/80 p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                  Execution mix
                </div>
                <div className="mt-2 text-sm font-semibold text-sky-950">
                  Drafts:{" "}
                  {formatCloseLoopCount(
                    supervisor.closeLoopActivity.draftCount,
                  )}
                </div>
                <div className="mt-1 text-sm font-semibold text-sky-950">
                  Autosends:{" "}
                  {formatCloseLoopCount(
                    supervisor.closeLoopActivity.autosendCount,
                  )}
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-2xl border border-sky-200 bg-white/80 p-3 text-xs text-sky-900">
              <div className="font-semibold uppercase tracking-[0.18em] text-sky-700">
                Close-loop outcomes
              </div>
              <div className="mt-2">
                Reply {formatPercent(supervisor.closeLoopOutcomes.replyRate)} |
                Preserved{" "}
                {formatPercent(supervisor.closeLoopOutcomes.preservedRate)} |
                Completed{" "}
                {formatPercent(supervisor.closeLoopOutcomes.completedRate)}
              </div>
              <div className="mt-1">
                Reschedule saves{" "}
                {formatPercent(supervisor.closeLoopOutcomes.rescheduleRate)} |
                Repeat booked{" "}
                {formatPercent(supervisor.closeLoopOutcomes.repeatBookRate)}
              </div>
              <div className="mt-2 text-[11px] text-sky-800">
                {supervisor.closeLoopOutcomes.appointmentCheckinWorthwhile
                  ? "Pre-appointment check-ins are earning their keep."
                  : "Pre-appointment check-ins are still a light-touch, still-learning action."}
                {" | "}
                {supervisor.closeLoopOutcomes.appointmentSupportWorthwhile
                  ? "Booked-job support is preserving momentum."
                  : "Booked-job support has no strong win signal yet."}
                {" | "}
                {supervisor.closeLoopOutcomes.appointmentSupportNeedsLightTouch
                  ? "Keep booked-job support extra light right now."
                  : "No strong light-touch warning on booked-job support."}
                {" | "}
                {supervisor.closeLoopOutcomes.postJobCheckinWorthwhile
                  ? "Post-job check-ins are generating healthy response or repeat-booking signal."
                  : "Post-job check-ins are still early and should stay low pressure."}
              </div>
            </div>
            {supervisor.closeLoopSegmentSignals.helping.length ||
            supervisor.closeLoopSegmentSignals.attention.length ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {supervisor.closeLoopSegmentSignals.helping.length ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs">
                    <div className="font-semibold uppercase tracking-[0.18em] text-emerald-700">
                      Helping By Segment
                    </div>
                    <div className="mt-3 space-y-2">
                      {supervisor.closeLoopSegmentSignals.helping.map(
                        (item) => (
                          <div
                            key={`${item.label}:${item.detail}`}
                            className="rounded-2xl border border-emerald-200 bg-white/80 p-3"
                          >
                            <div className="text-sm font-semibold text-emerald-950">
                              {item.label}
                            </div>
                            <div className="mt-1 text-xs text-emerald-900">
                              {item.detail}
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ) : null}
                {supervisor.closeLoopSegmentSignals.attention.length ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-xs">
                    <div className="font-semibold uppercase tracking-[0.18em] text-amber-800">
                      Slipping By Segment
                    </div>
                    <div className="mt-3 space-y-2">
                      {supervisor.closeLoopSegmentSignals.attention.map(
                        (item) => (
                          <div
                            key={`${item.label}:${item.detail}`}
                            className={`rounded-2xl border p-3 ${
                              item.tone === "bad"
                                ? "border-rose-200 bg-rose-50/80"
                                : "border-amber-200 bg-white/80"
                            }`}
                          >
                            <div
                              className={`text-sm font-semibold ${item.tone === "bad" ? "text-rose-900" : "text-amber-950"}`}
                            >
                              {item.label}
                            </div>
                            <div
                              className={`mt-1 text-xs ${item.tone === "bad" ? "text-rose-800" : "text-amber-900"}`}
                            >
                              {item.detail}
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {supervisor.attentionItems.length ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">
                Needs Attention
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {supervisor.attentionItems.map((item) => (
                  <div
                    key={`${item.label}:${item.detail}`}
                    className={`rounded-2xl border p-3 ${
                      item.tone === "bad"
                        ? "border-rose-200 bg-rose-50/80"
                        : "border-amber-200 bg-white/80"
                    }`}
                  >
                    <div
                      className={`text-sm font-semibold ${item.tone === "bad" ? "text-rose-900" : "text-amber-950"}`}
                    >
                      {item.label}
                    </div>
                    <div
                      className={`mt-1 text-xs ${item.tone === "bad" ? "text-rose-800" : "text-amber-900"}`}
                    >
                      {item.detail}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {supervisor.topWins.length ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Agent Wins Right Now
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {supervisor.topWins.map((item) => (
                  <div
                    key={`${item.label}:${item.detail}`}
                    className="rounded-2xl border border-emerald-200 bg-white/80 p-3"
                  >
                    <div className="text-sm font-semibold text-emerald-950">
                      {item.label}
                    </div>
                    <div className="mt-1 text-xs text-emerald-900">
                      {item.detail}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs text-[color:var(--team-text-muted)]">
          Activity counts below summarize the visible page. Supervisor metrics
          cover the selected seven-day window.
        </p>
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Outbound calls
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.outboundCalls}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Outbound messages
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.outboundMessages}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Inbound messages
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.inboundMessages}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Agent drafts
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.agentDrafts}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Agent autosends
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.agentAutosends}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/40 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Reminders
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {summary.reminders}
            </p>
          </div>
        </div>
      </div>

      <nav
        aria-label="Sales activity pages"
        className="flex flex-col gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="text-[color:var(--team-text-muted)]">
          {rows.length > 0
            ? `Showing ${rows.length} of ${page.totalAtSnapshot} matching events in this fixed snapshot${page.position === "history" ? " (historical page)" : ""}`
            : `No events in this ${activityPayload.rangeDays}-day window`}
        </span>
        <div className="flex flex-wrap gap-2">
          {page.newerCursor ? (
            <a
              href={pageHref(page.newerCursor)}
              className="inline-flex min-h-[44px] items-center rounded-xl border border-[color:var(--team-border)] px-4 py-2 font-semibold text-[color:var(--team-text)]"
            >
              Newer
            </a>
          ) : (
            <span className="inline-flex min-h-[44px] items-center px-4 py-2 text-[color:var(--team-text-soft)]">
              No newer page
            </span>
          )}
          {page.olderCursor ? (
            <a
              href={pageHref(page.olderCursor)}
              className="inline-flex min-h-[44px] items-center rounded-xl border border-[color:var(--team-border)] px-4 py-2 font-semibold text-[color:var(--team-text)]"
            >
              Older
            </a>
          ) : (
            <span className="inline-flex min-h-[44px] items-center px-4 py-2 text-[color:var(--team-text-soft)]">
              No older page
            </span>
          )}
          {page.position === "history" ? (
            <a
              href={newestHref}
              className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700"
            >
              Return newest
            </a>
          ) : null}
        </div>
      </nav>

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
              { calls: 0, outbound: 0, inbound: 0 },
            );

            return (
              <div
                key={dayKey}
                className="rounded-3xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/50 backdrop-blur"
              >
                <div className="flex flex-col gap-2 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-semibold text-slate-900">
                    {dayKey}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">
                      Calls: {daySummary.calls}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">
                      Outbound: {daySummary.outbound}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold">
                      Inbound: {daySummary.inbound}
                    </span>
                  </div>
                </div>

                <div className="space-y-3 p-4 sm:hidden">
                  {dayRows.map((row) => (
                    <article
                      key={row.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">
                            {row.whenLocal}
                          </div>
                          <div className="text-xs text-slate-500">
                            {row.ago}
                          </div>
                        </div>
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                          {row.type}
                        </span>
                      </div>
                      <div className="mt-3 text-xs text-slate-600">
                        Channel:{" "}
                        <span className="font-medium text-slate-700">
                          {row.channel ?? "-"}
                        </span>
                      </div>
                      <div className="mt-3 text-sm font-medium text-slate-900">
                        {row.summary}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Actor: {row.actor}
                      </div>
                      <div className="mt-3">
                        <ActivityContextLinks row={row} compact />
                      </div>
                    </article>
                  ))}
                </div>

                <div className="hidden overflow-x-auto sm:block">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <tr>
                        <th className="whitespace-nowrap px-4 py-3">When</th>
                        <th className="whitespace-nowrap px-4 py-3">Type</th>
                        <th className="whitespace-nowrap px-4 py-3">Channel</th>
                        <th className="whitespace-nowrap px-4 py-3">Related</th>
                        <th className="px-4 py-3">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {dayRows.map((row) => (
                        <tr key={row.id} className="text-slate-700">
                          <td className="whitespace-nowrap px-4 py-3">
                            <div className="font-medium text-slate-900">
                              {row.whenLocal}
                            </div>
                            <div className="text-xs text-slate-500">
                              {row.ago}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                              {row.type}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600">
                            {row.channel ?? "-"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs">
                            {row.contactId ||
                            row.threadId ||
                            row.callRecordId ? (
                              <ActivityContextLinks row={row} />
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900">
                              {row.summary}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              Actor: {row.actor}
                            </div>
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
