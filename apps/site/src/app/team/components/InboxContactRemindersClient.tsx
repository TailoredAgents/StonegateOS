"use client";

import React from "react";
import type { ContactReminderSummary } from "./contacts.types";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamButtonClass } from "./team-ui";
import {
  parseReminderMutationSuccess,
  stableReminderMutationAttempt,
  type ReminderMutationAttempt,
} from "../lib/reminder-mutation";
import {
  readTeamMutationError,
  readTeamMutationException,
} from "../lib/mutation-feedback";

type Props = {
  contactId: string;
  initialReminders: ContactReminderSummary[];
  readOnly?: boolean;
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
    minute: "2-digit",
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

export function InboxContactRemindersClient({
  contactId,
  initialReminders,
  readOnly = false,
}: Props): React.ReactElement {
  const [reminders, setReminders] = React.useState<ContactReminderSummary[]>(
    () => initialReminders ?? [],
  );
  const [showForm, setShowForm] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("Call back");
  const [dueDraft, setDueDraft] = React.useState("");
  const [notesDraft, setNotesDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [completingId, setCompletingId] = React.useState<string | null>(null);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitleDraft, setEditTitleDraft] = React.useState("");
  const [editDueDraft, setEditDueDraft] = React.useState("");
  const [editNotesDraft, setEditNotesDraft] = React.useState("");
  const [editSavingId, setEditSavingId] = React.useState<string | null>(null);
  const createAttemptRef = React.useRef<ReminderMutationAttempt | null>(null);
  const editAttemptRef = React.useRef<ReminderMutationAttempt | null>(null);
  const completionAttemptsRef = React.useRef(
    new Map<string, ReminderMutationAttempt>(),
  );

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
    setNotice(null);
    const fingerprint = JSON.stringify({ contactId, dueAt, notes, title });
    const attempt = stableReminderMutationAttempt(
      createAttemptRef.current,
      fingerprint,
      `crm-reminder-create:${contactId}`,
    );
    createAttemptRef.current = attempt;

    try {
      const response = await fetch("/api/team/contacts/reminders", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
        },
        body: JSON.stringify({
          contactId,
          dueAt,
          title,
          notes: notes.length ? notes : undefined,
        }),
      });

      if (!response.ok) {
        setError(
          await readTeamMutationError(response, "Unable to create reminder"),
        );
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const success = parseReminderMutationSuccess(data, {
        contactId,
        status: "open",
      });
      if (!success) {
        setError(
          "The reminder service returned an unreadable receipt. No success is being claimed; your input is still here. Refresh before retrying.",
        );
        return;
      }
      const created: ContactReminderSummary = success.data.reminder;

      setReminders((prev) => [created, ...prev]);
      createAttemptRef.current = null;
      setShowForm(false);
      setTitleDraft("Call back");
      setDueDraft("");
      setNotesDraft("");
      setNotice("Reminder created and notification scheduled.");
    } catch (caught) {
      setError(
        readTeamMutationException(
          caught,
          "The reminder service could not be reached. Your reminder was not confirmed; your input is still here so you can retry",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function completeReminder(taskId: string) {
    if (completingId) return;
    const reminder = reminders.find((item) => item.id === taskId);
    if (!reminder) {
      setError("This reminder is no longer available. Refresh and try again.");
      return;
    }
    setCompletingId(taskId);
    setError(null);
    setNotice(null);
    const fingerprint = JSON.stringify({
      status: "completed",
      taskId,
      version: reminder.updatedAt,
    });
    const attempt = stableReminderMutationAttempt(
      completionAttemptsRef.current.get(taskId) ?? null,
      fingerprint,
      `crm-reminder-complete:${taskId}`,
    );
    completionAttemptsRef.current.set(taskId, attempt);

    try {
      const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
          "If-Match": `"${reminder.updatedAt}"`,
        },
      });

      if (!response.ok) {
        setError(
          await readTeamMutationError(response, "Unable to complete reminder"),
        );
        return;
      }
      const data = (await response.json().catch(() => null)) as unknown;
      const success = parseReminderMutationSuccess(data, {
        status: "completed",
        taskId,
      });
      if (!success) {
        setError(
          "The reminder service returned an unreadable completion receipt. No success is being claimed; refresh before retrying.",
        );
        return;
      }
      setReminders((prev) => prev.filter((reminder) => reminder.id !== taskId));
      completionAttemptsRef.current.delete(taskId);
      setNotice("Reminder completed.");
    } catch (caught) {
      setError(
        readTeamMutationException(
          caught,
          "The reminder service could not be reached. Completion was not confirmed; refresh before retrying",
        ),
      );
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
    setNotice(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitleDraft("");
    setEditDueDraft("");
    setEditNotesDraft("");
  }

  async function saveEdit(taskId: string) {
    if (editSavingId) return;
    const current = reminders.find((item) => item.id === taskId);
    if (!current) {
      setError("This reminder is no longer available. Refresh and try again.");
      return;
    }

    const title = editTitleDraft.trim().length
      ? editTitleDraft.trim()
      : "Call back";
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
    setNotice(null);
    const fingerprint = JSON.stringify({
      dueAt,
      notes,
      taskId,
      title,
      version: current.updatedAt,
    });
    const attempt = stableReminderMutationAttempt(
      editAttemptRef.current,
      fingerprint,
      `crm-reminder-update:${taskId}`,
    );
    editAttemptRef.current = attempt;

    try {
      const response = await fetch(`/api/team/contacts/reminders/${taskId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
          "If-Match": `"${current.updatedAt}"`,
        },
        body: JSON.stringify({ title, dueAt, notes }),
      });

      if (!response.ok) {
        setError(
          await readTeamMutationError(response, "Unable to update reminder"),
        );
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const success = parseReminderMutationSuccess(data, {
        status: "open",
        taskId,
      });
      if (!success) {
        setError(
          "The reminder service returned an unreadable update receipt. No success is being claimed; your changes remain available. Refresh before retrying.",
        );
        return;
      }
      const updated = success.data.reminder;

      setReminders((prev) =>
        prev.map((existing) => (existing.id === taskId ? updated : existing)),
      );

      editAttemptRef.current = null;
      cancelEdit();
      setNotice("Reminder updated.");
    } catch (caught) {
      setError(
        readTeamMutationException(
          caught,
          "The reminder service could not be reached. Your changes were not confirmed and remain available to retry",
        ),
      );
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
    <section aria-label="Contact reminders" className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Reminders
        </div>
        {!readOnly ? (
          <button
            type="button"
            onClick={() => {
              setShowForm((prev) => !prev);
              setError(null);
              setNotice(null);
            }}
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
          >
            {showForm ? "Close" : "Add"}
          </button>
        ) : (
          <span className="text-[11px] text-slate-500">Read only</span>
        )}
      </div>

      {!readOnly && showForm ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-700">
              Title
              <input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={160}
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
                maxLength={4000}
                rows={3}
                className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
          </div>
          {error ? (
            <div
              className="mt-2 text-xs font-semibold text-rose-600"
              role="alert"
            >
              {error}
            </div>
          ) : null}
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
            <button
              type="button"
              className={teamButtonClass("primary", "sm")}
              onClick={() => void submitReminder()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {!showForm && error ? (
        <div className="text-xs font-semibold text-rose-600" role="alert">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="text-xs font-semibold text-emerald-700" role="status">
          {notice}
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-xs text-slate-500">
          No reminders yet. Use these for call-backs and follow-ups.
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.slice(0, 10).map((reminder) => {
            const isEditing = editingId === reminder.id;
            return (
              <div
                key={reminder.id}
                className="rounded-2xl border border-slate-200 bg-white p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      {reminder.title}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-500">
                      {formatReminderTimestamp(reminder.dueAt)}
                    </div>
                  </div>
                  {!readOnly ? (
                    <div className="flex items-center gap-2">
                      {!isEditing ? (
                        <button
                          type="button"
                          onClick={() => startEdit(reminder)}
                          className="min-h-11 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        >
                          Edit
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void completeReminder(reminder.id)}
                        disabled={completingId === reminder.id}
                        className="min-h-11 rounded-lg px-2 text-xs font-semibold text-emerald-700 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-60"
                      >
                        {completingId === reminder.id ? "Done…" : "Done"}
                      </button>
                    </div>
                  ) : null}
                </div>

                {!readOnly && isEditing ? (
                  <div className="mt-2 space-y-2">
                    <label className="block text-xs font-semibold text-slate-700">
                      Title
                      <input
                        value={editTitleDraft}
                        onChange={(event) =>
                          setEditTitleDraft(event.target.value)
                        }
                        maxLength={160}
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-slate-700">
                      When
                      <input
                        type="datetime-local"
                        value={editDueDraft}
                        onChange={(event) =>
                          setEditDueDraft(event.target.value)
                        }
                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-slate-700">
                      Notes (optional)
                      <textarea
                        value={editNotesDraft}
                        onChange={(event) =>
                          setEditNotesDraft(event.target.value)
                        }
                        maxLength={4000}
                        rows={3}
                        className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                      />
                    </label>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={cancelEdit}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={teamButtonClass("primary", "sm")}
                        onClick={() => void saveEdit(reminder.id)}
                        disabled={editSavingId === reminder.id}
                      >
                        {editSavingId === reminder.id ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : reminder.notes ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                    {reminder.notes}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
