"use client";

import React from "react";
import type { ContactReminderSummary, ContactSummary } from "./contacts.types";
import { PIPELINE_STAGES, badgeClassForPipelineStage, labelForPipelineStage } from "./pipeline.stages";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamButtonClass } from "./team-ui";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import { startContactCallAction } from "../actions";

type Props = {
  contact: ContactSummary;
  teamMembers: Array<{ id: string; name: string }>;
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
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

function buildMapsLink(contact: ContactSummary): string | null {
  const property = (contact.properties ?? [])[0];
  if (!property) return null;
  const parts = [property.addressLine1, property.city, property.state, property.postalCode].filter(Boolean);
  const query = parts.join(", ").trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function ContactsDetailsPaneClient({ contact, teamMembers }: Props): React.ReactElement {
  const memberNameById = React.useMemo(() => new Map(teamMembers.map((m) => [m.id, m.name])), [teamMembers]);
  const [stage, setStage] = React.useState(() => contact.pipeline?.stage ?? "new");
  const [assignee, setAssignee] = React.useState<string | null>(() => contact.salespersonMemberId ?? null);

  const [stageSaving, setStageSaving] = React.useState(false);
  const [stageError, setStageError] = React.useState<string | null>(null);

  const [assigneeSaving, setAssigneeSaving] = React.useState(false);
  const [assigneeError, setAssigneeError] = React.useState<string | null>(null);

  const [systemTasks, setSystemTasks] = React.useState<ContactReminderSummary[]>(() =>
    (contact.reminders ?? []).filter(isSystemTask).sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""))
  );

  const manualReminders = React.useMemo(() => {
    return (contact.reminders ?? [])
      .filter((reminder) => !isSystemTask(reminder))
      .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
  }, [contact.reminders]);

  const initialNotes = React.useMemo(() => {
    return [...(contact.notes ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [contact.notes]);

  async function updateStage(nextStage: string) {
    if (stageSaving) return;
    setStageSaving(true);
    setStageError(null);
    try {
      const response = await fetch("/api/team/contacts/pipeline", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, stage: nextStage })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        setStageError(typeof data?.message === "string" ? data.message : "Unable to update stage.");
        return;
      }

      setStage(nextStage);
    } finally {
      setStageSaving(false);
    }
  }

  async function updateAssignee(nextAssignee: string | null) {
    if (assigneeSaving) return;
    setAssigneeSaving(true);
    setAssigneeError(null);
    try {
      const response = await fetch("/api/team/contacts/assignee", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, salespersonMemberId: nextAssignee })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        setAssigneeError(typeof data?.message === "string" ? data.message : "Unable to update assignment.");
        return;
      }

      setAssignee(nextAssignee);
    } finally {
      setAssigneeSaving(false);
    }
  }

  async function completeSystemTask(taskId: string) {
    if (!window.confirm("Mark this task done?")) return;
    const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return;
    setSystemTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  const mapsLink = buildMapsLink(contact);
  const assignedLabel = assignee ? memberNameById.get(assignee) ?? "Assigned" : "Unassigned";
  const canCall = Boolean(contact.phoneE164 ?? contact.phone);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-lg font-semibold text-slate-900">{contact.name}</div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(
                stage
              )}`}
            >
              {labelForPipelineStage(stage)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
            {contact.phone ? <span className="rounded-full bg-slate-100 px-3 py-1">{contact.phone}</span> : null}
            {contact.email ? <span className="rounded-full bg-slate-100 px-3 py-1">{contact.email}</span> : null}
            <span className="rounded-full bg-slate-100 px-3 py-1">Assigned: {assignedLabel}</span>
          </div>
        </div>
        <ContactNameEditorClient contactId={contact.id} contactName={contact.name} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          action={startContactCallAction}
          className="inline"
          onSubmit={(event) => {
            if (!canCall) {
              event.preventDefault();
              return;
            }
            const label = contact.phone ?? "this contact";
            if (!window.confirm(`Call ${contact.name} (${label}) from the Stonegate number?`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="contactId" value={contact.id} />
          <button type="submit" className={teamButtonClass("primary", "sm")} disabled={!canCall}>
            Call
          </button>
        </form>
        <a className={teamButtonClass("secondary", "sm")} href={`/team?tab=inbox&contactId=${encodeURIComponent(contact.id)}`}>
          Message
        </a>
        <a className={teamButtonClass("secondary", "sm")} href={`/team?tab=calendar&contactId=${encodeURIComponent(contact.id)}`}>
          Calendar
        </a>
        <a
          className={`${teamButtonClass("secondary", "sm")} ${mapsLink ? "" : "pointer-events-none opacity-50"}`}
          href={mapsLink ?? "#"}
          target="_blank"
          rel="noreferrer"
        >
          Maps
        </a>
      </div>

      <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Stage</span>
            <select
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              value={stage}
              disabled={stageSaving}
              onChange={(e) => void updateStage(e.target.value)}
            >
              {PIPELINE_STAGES.map((value) => (
                <option key={value} value={value}>
                  {labelForPipelineStage(value)}
                </option>
              ))}
            </select>
            {stageError ? <span className="mt-1 text-xs font-semibold text-rose-600">{stageError}</span> : null}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Assigned to</span>
            <select
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              value={assignee ?? ""}
              disabled={assigneeSaving}
              onChange={(e) => void updateAssignee(e.target.value.trim().length ? e.target.value : null)}
            >
              <option value="">(Unassigned)</option>
              {teamMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            {assigneeError ? <span className="mt-1 text-xs font-semibold text-rose-600">{assigneeError}</span> : null}
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1">Appointments: {contact.stats?.appointments ?? 0}</span>
          <span className="rounded-full bg-slate-100 px-3 py-1">Quotes: {contact.stats?.quotes ?? 0}</span>
          <span className="rounded-full bg-slate-100 px-3 py-1">Notes: {contact.notesCount ?? (contact.notes?.length ?? 0)}</span>
        </div>
        <div className="text-[11px] text-slate-500">Last activity: {formatDateTime(contact.lastActivityAt)}</div>
      </div>

      {systemTasks.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">System tasks</div>
          <div className="space-y-2">
            {systemTasks.slice(0, 6).map((task) => (
              <div key={task.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800">{task.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatDateTime(task.dueAt)}</div>
                    {task.notes ? <div className="mt-1 text-xs text-slate-600 line-clamp-2">{task.notes}</div> : null}
                  </div>
                  <button type="button" className={teamButtonClass("secondary", "sm")} onClick={() => void completeSystemTask(task.id)}>
                    Mark done
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <InboxContactRemindersClient contactId={contact.id} initialReminders={manualReminders} />
      <InboxContactNotesClient contactId={contact.id} initialNotes={initialNotes} />
    </div>
  );
}

