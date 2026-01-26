"use client";

import React from "react";
import type { ContactReminderSummary } from "./contacts.types";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamButtonClass } from "./team-ui";

type Props = {
  contactId: string;
  initialReminders: ContactReminderSummary[];
};

function formatReminderTimestamp(value: string | null): string {
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

function toLocalDateTimeInputValue(iso: string | null): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = parsed.getFullYear();
  const month = pad(parsed.getMonth() + 1);
  const day = pad(parsed.getDate());
  const hours = pad(parsed.getHours());
  const minutes = pad(parsed.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function InboxContactRemindersClient({ contactId, initialReminders }: Props): React.ReactElement {
  const [reminders, setReminders] = React.useState<ContactReminderSummary[]>(() => initialReminders ?? []);
  const [showForm, setShowForm] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("Call back");
  const [dueDraft, setDueDraft] = React.useState("");
  const [notesDraft, setNotesDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [completingId, setCompletingId] = React.useState<string | null>(null);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitleDraft, setEditTitleDraft] = React.useState("");
  const [editDueDraft, setEditDueDraft] = React.useState("");
  const [editNotesDraft, setEditNotesDraft] = React.useState("");
  const [editSavingId, setEditSavingId] = React.useState<string | null>(null);

  async function submitReminder() {
    if (saving) return;

    const dueRaw = dueDraft.trim();
    if (!dueRaw) {
      setError("Pick a date/time for the reminder.");
      return;
    }

    const dueDate = new Date(dueRaw);
    if (Number.isNaN(dueDate.getTime())) {
      setError("Invalid reminder time.");
      return;
    }

    const dueAt = dueDate.toISOString();
    const title = titleDraft.trim().length ? titleDraft.trim() : "Call back";
    const notes = notesDraft.trim();

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/team/contacts/reminders", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          dueAt,
          title,
          notes: notes.length ? notes : undefined
        })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to create reminder. Please try again.";
        setError(message);
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const reminder = data && typeof data === "object" ? (data as Record<string, unknown>)["reminder"] : null;
      const record = reminder && typeof reminder === "object" ? (reminder as Record<string, unknown>) : null;
      if (
        typeof record?.["id"] !== "string" ||
        typeof record?.["title"] !== "string" ||
        typeof record?.["createdAt"] !== "string" ||
        typeof record?.["updatedAt"] !== "string"
      ) {
        setError("Unable to create reminder. Please try again.");
        return;
      }

      const created: ContactReminderSummary = {
        id: String(record["id"]),
        title: String(record["title"]),
        notes: typeof record["notes"] === "string" ? String(record["notes"]) : null,
        dueAt: typeof record["dueAt"] === "string" ? String(record["dueAt"]) : dueAt,
        assignedTo: typeof record["assignedTo"] === "string" ? String(record["assignedTo"]) : null,
        status: record["status"] === "completed" ? "completed" : "open",
        createdAt: String(record["createdAt"]),
        updatedAt: String(record["updatedAt"])
      };

      setReminders((prev) => [created, ...prev]);
      setShowForm(false);
      setTitleDraft("Call back");
      setDueDraft("");
      setNotesDraft("");
    } finally {
      setSaving(false);
    }
  }

  async function completeReminder(taskId: string) {
    if (completingId) return;
    setCompletingId(taskId);
    setError(null);

    try {
      const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to complete reminder. Please try again.";
        setError(message);
        return;
      }

      setReminders((prev) => prev.filter((reminder) => reminder.id !== taskId));
    } finally {
      setCompletingId(null);
    }
  }

  function startEdit(reminder: ContactReminderSummary) {
    setEditingId(reminder.id);
    setEditTitleDraft(reminder.title);
    setEditDueDraft(toLocalDateTimeInputValue(reminder.dueAt));
    setEditNotesDraft(reminder.notes ?? "");
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitleDraft("");
    setEditDueDraft("");
    setEditNotesDraft("");
  }

  async function saveEdit(taskId: string) {
    if (editSavingId) return;

    const title = editTitleDraft.trim().length ? editTitleDraft.trim() : "Call back";
    const dueRaw = editDueDraft.trim();
    if (!dueRaw) {
      setError("Pick a date/time for the reminder.");
      return;
    }
    const dueDate = new Date(dueRaw);
    if (Number.isNaN(dueDate.getTime())) {
      setError("Invalid reminder time.");
      return;
    }

    const dueAt = dueDate.toISOString();
    const notes = editNotesDraft.trim();

    setEditSavingId(taskId);
    setError(null);

    try {
      const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ title, dueAt, notes })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to update reminder. Please try again.";
        setError(message);
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const reminder = data && typeof data === "object" ? (data as Record<string, unknown>)["reminder"] : null;
      const record = reminder && typeof reminder === "object" ? (reminder as Record<string, unknown>) : null;
      const updatedAt = typeof record?.["updatedAt"] === "string" ? String(record["updatedAt"]) : null;
      const serverDueAt = typeof record?.["dueAt"] === "string" ? String(record["dueAt"]) : dueAt;
      const serverNotes = typeof record?.["notes"] === "string" ? String(record["notes"]) : null;

      setReminders((prev) =>
        prev.map((existing) =>
          existing.id === taskId
            ? {
                ...existing,
                title,
                dueAt: serverDueAt,
                notes: serverNotes ?? (notes.length ? notes : null),
                updatedAt: updatedAt ?? existing.updatedAt
              }
            : existing
        )
      );

      cancelEdit();
    } finally {
      setEditSavingId(null);
    }
  }

  const sorted = [...reminders].sort((a, b) => {
    const aTime = a.dueAt ? Date.parse(a.dueAt) : 0;
    const bTime = b.dueAt ? Date.parse(b.dueAt) : 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.title.localeCompare(b.title);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reminders</div>
        <button
          type="button"
          onClick={() => {
            setShowForm((prev) => !prev);
            setError(null);
          }}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
        >
          {showForm ? "Close" : "Add"}
        </button>
      </div>

      {showForm ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-700">
              Title
              <input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              When
              <input
                type="datetime-local"
                value={dueDraft}
                onChange={(event) => setDueDraft(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Notes (optional)
              <textarea
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
          </div>
          {error ? <div className="mt-2 text-xs font-semibold text-rose-600">{error}</div> : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="button" className={teamButtonClass("primary", "sm")} onClick={submitReminder} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {!showForm && error ? <div className="text-xs font-semibold text-rose-600">{error}</div> : null}

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-xs text-slate-500">
          No reminders yet. Use these for call-backs and follow-ups.
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.slice(0, 10).map((reminder) => {
            const isEditing = editingId === reminder.id;
            return (
              <div key={reminder.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{reminder.title}</div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-500">{formatReminderTimestamp(reminder.dueAt)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isEditing ? (
                      <button
                        type="button"
                        onClick={() => startEdit(reminder)}
                        className="text-xs font-semibold text-slate-600 hover:text-primary-700"
                      >
                        Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => completeReminder(reminder.id)}
                      disabled={completingId === reminder.id}
                      className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 disabled:opacity-60"
                    >
                      {completingId === reminder.id ? "Done…" : "Done"}
                    </button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-2 space-y-2">
                    <input
                      value={editTitleDraft}
                      onChange={(event) => setEditTitleDraft(event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                    <input
                      type="datetime-local"
                      value={editDueDraft}
                      onChange={(event) => setEditDueDraft(event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                    <textarea
                      value={editNotesDraft}
                      onChange={(event) => setEditNotesDraft(event.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" className={teamButtonClass("secondary", "sm")} onClick={cancelEdit}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={teamButtonClass("primary", "sm")}
                        onClick={() => saveEdit(reminder.id)}
                        disabled={editSavingId === reminder.id}
                      >
                        {editSavingId === reminder.id ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : reminder.notes ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{reminder.notes}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

