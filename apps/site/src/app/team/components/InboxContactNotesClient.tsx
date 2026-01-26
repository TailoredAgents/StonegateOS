"use client";

import React from "react";
import type { ContactNoteSummary } from "./contacts.types";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamButtonClass } from "./team-ui";

type Props = {
  contactId: string;
  initialNotes: ContactNoteSummary[];
};

function formatNoteTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

export function InboxContactNotesClient({ contactId, initialNotes }: Props): React.ReactElement {
  const [notes, setNotes] = React.useState<ContactNoteSummary[]>(() => initialNotes ?? []);
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  const [editSavingId, setEditSavingId] = React.useState<string | null>(null);

  async function createNote() {
    if (saving) return;
    const body = draft.trim();
    if (!body) {
      setError("Please type a note first.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/team/contacts/notes", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, body })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to save note. Please try again.";
        setError(message);
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const note = data && typeof data === "object" ? (data as Record<string, unknown>)["note"] : null;
      if (!note || typeof note !== "object") {
        setError("Unable to save note. Please try again.");
        return;
      }

      const noteRecord = note as Record<string, unknown>;
      if (
        typeof noteRecord["id"] !== "string" ||
        typeof noteRecord["body"] !== "string" ||
        typeof noteRecord["createdAt"] !== "string" ||
        typeof noteRecord["updatedAt"] !== "string"
      ) {
        setError("Unable to save note. Please try again.");
        return;
      }

      const created: ContactNoteSummary = {
        id: noteRecord["id"],
        body: noteRecord["body"],
        createdAt: noteRecord["createdAt"],
        updatedAt: noteRecord["updatedAt"]
      };

      setNotes((prev) => [created, ...prev]);
      setDraft("");
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote(noteId: string) {
    if (deletingId) return;
    if (!window.confirm("Delete this note?")) return;

    setDeletingId(noteId);
    setError(null);

    try {
      const response = await fetch(`/api/team/contacts/notes/${noteId}`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to delete note. Please try again.";
        setError(message);
        return;
      }

      setNotes((prev) => prev.filter((existing) => existing.id !== noteId));
    } finally {
      setDeletingId(null);
    }
  }

  function startEditNote(note: ContactNoteSummary) {
    setEditingId(note.id);
    setEditDraft(note.body);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
  }

  async function saveEditedNote(noteId: string) {
    if (editSavingId) return;
    const body = editDraft.trim();
    if (!body) {
      setError("Please type a note first.");
      return;
    }

    setEditSavingId(noteId);
    setError(null);

    try {
      const response = await fetch(`/api/team/contacts/notes/${noteId}`, {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ body })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const message =
          data && typeof data === "object" && typeof (data as Record<string, unknown>)["message"] === "string"
            ? String((data as Record<string, unknown>)["message"])
            : "Unable to update note. Please try again.";
        setError(message);
        return;
      }

      const data = (await response.json().catch(() => null)) as unknown;
      const note = data && typeof data === "object" ? (data as Record<string, unknown>)["note"] : null;
      const noteRecord = note && typeof note === "object" ? (note as Record<string, unknown>) : null;
      const updatedAt = typeof noteRecord?.["updatedAt"] === "string" ? noteRecord["updatedAt"] : null;

      setNotes((prev) =>
        prev.map((existing) =>
          existing.id === noteId
            ? {
                ...existing,
                body,
                updatedAt: updatedAt ?? existing.updatedAt
              }
            : existing
        )
      );

      setEditingId(null);
      setEditDraft("");
    } finally {
      setEditSavingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</div>
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
          <label className="block text-xs font-semibold text-slate-700">New note</label>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            placeholder="Capture what matters from this conversation…"
          />
          {error ? <div className="mt-2 text-xs font-semibold text-rose-600">{error}</div> : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                setShowForm(false);
                setDraft("");
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={teamButtonClass("primary", "sm")}
              onClick={createNote}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {!showForm && error ? <div className="text-xs font-semibold text-rose-600">{error}</div> : null}

      {notes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-xs text-slate-500">
          No notes yet. Use notes to capture details from calls and follow-ups.
        </div>
      ) : (
        <div className="space-y-3">
          {notes.slice(0, 10).map((note) => {
            const isEditing = editingId === note.id;
            const timestamp = formatNoteTimestamp(note.updatedAt || note.createdAt);
            return (
              <div key={note.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold text-slate-500">{timestamp}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isEditing ? (
                      <button
                        type="button"
                        onClick={() => startEditNote(note)}
                        className="text-xs font-semibold text-slate-600 hover:text-primary-700"
                      >
                        Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => deleteNote(note.id)}
                      disabled={deletingId === note.id}
                      className="text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:opacity-60"
                    >
                      {deletingId === note.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-2">
                    <textarea
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      rows={4}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button type="button" className={teamButtonClass("secondary", "sm")} onClick={cancelEdit}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={teamButtonClass("primary", "sm")}
                        onClick={() => saveEditedNote(note.id)}
                        disabled={editSavingId === note.id}
                      >
                        {editSavingId === note.id ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{note.body}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

