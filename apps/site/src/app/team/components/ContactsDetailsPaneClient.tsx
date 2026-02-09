"use client";

import React from "react";
import type { ContactReminderSummary, ContactSummary } from "./contacts.types";
import { PIPELINE_STAGES, badgeClassForPipelineStage, labelForPipelineStage } from "./pipeline.stages";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamButtonClass } from "./team-ui";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { ContactPhoneEditorClient } from "./ContactPhoneEditorClient";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import { SubmitButton } from "@/components/SubmitButton";
import {
  addPropertyAction,
  bookAppointmentAction,
  deleteContactAction,
  deletePropertyAction,
  partnerPortalInviteUserAction,
  startContactCallAction,
  updatePropertyAction
} from "../actions";

type Props = {
  contact: ContactSummary;
  teamMembers: Array<{ id: string; name: string }>;
};

type QuotePhotosPayload = {
  ok?: boolean;
  photoUrls?: string[];
  error?: string;
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

function buildMapsLinkForProperty(property: ContactSummary["properties"][number] | null | undefined): string | null {
  if (!property) return null;
  const parts = [property.addressLine1, property.addressLine2 ?? "", property.city, property.state, property.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

export function ContactsDetailsPaneClient({ contact, teamMembers }: Props): React.ReactElement {
  const memberNameById = React.useMemo(() => new Map(teamMembers.map((m) => [m.id, m.name])), [teamMembers]);
  const [stage, setStage] = React.useState(() => contact.pipeline?.stage ?? "new");
  const [assignee, setAssignee] = React.useState<string | null>(() => contact.salespersonMemberId ?? null);
  const [showBookingForm, setShowBookingForm] = React.useState(false);
  const [addingProperty, setAddingProperty] = React.useState(false);
  const [editingPropertyId, setEditingPropertyId] = React.useState<string | null>(null);
  const [quotePhotoUrls, setQuotePhotoUrls] = React.useState<string[]>([]);
  const [quotePhotosStatus, setQuotePhotosStatus] = React.useState<"idle" | "loading" | "error">("idle");

  React.useEffect(() => {
    setShowBookingForm(false);
    setAddingProperty(false);
    setEditingPropertyId(null);
    setStage(contact.pipeline?.stage ?? "new");
    setAssignee(contact.salespersonMemberId ?? null);
    setSystemTasks((contact.reminders ?? []).filter(isSystemTask).sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? "")));
  }, [contact.id]);

  React.useEffect(() => {
    const controller = new AbortController();
    setQuotePhotosStatus("loading");

    void (async () => {
      try {
        const response = await fetch(`/api/team/contacts/quote-photos?contactId=${encodeURIComponent(contact.id)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        const data = (await response.json().catch(() => null)) as QuotePhotosPayload | null;
        if (!response.ok || !data?.ok) {
          throw new Error(typeof data?.error === "string" ? data.error : "Unable to load quote photos.");
        }
        const urls = Array.isArray(data.photoUrls) ? data.photoUrls.filter((url) => typeof url === "string" && url.trim().length > 0) : [];
        setQuotePhotoUrls(urls);
        setQuotePhotosStatus("idle");
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setQuotePhotoUrls([]);
        setQuotePhotosStatus("error");
      }
    })();

    return () => controller.abort();
  }, [contact.id]);

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
  const primaryPropertyId = (contact.properties ?? [])[0]?.id ?? "";

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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ContactPhoneEditorClient contactId={contact.id} phone={contact.phone} email={contact.email} />
          <ContactNameEditorClient contactId={contact.id} contactName={contact.name} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          action={startContactCallAction}
          method="post"
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
        <button type="button" className={teamButtonClass("secondary", "sm")} onClick={() => setShowBookingForm((prev) => !prev)}>
          {showBookingForm ? "Close booking" : "Book appointment"}
        </button>
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
        <form
          action={deleteContactAction}
          className="inline"
          onSubmit={(event) => {
            if (!window.confirm(`Delete ${contact.name}? This cannot be undone.`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="contactId" value={contact.id} />
          <SubmitButton className={teamButtonClass("danger", "sm")} pendingLabel="Deleting...">
            Delete
          </SubmitButton>
        </form>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Partner portal</h3>
            <p className="mt-1 text-xs text-slate-500">
              Invite this contact to the Partner Portal. Sending an invite also marks them as a partner.
            </p>
          </div>
          <a
            className={teamButtonClass("secondary", "sm")}
            href={`/team?tab=partners&p_selected=${encodeURIComponent(contact.id)}`}
          >
            Advanced setup
          </a>
        </div>

        <form
          action={partnerPortalInviteUserAction}
          className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-2"
          onSubmit={(event) => {
            const label = contact.email ?? contact.phone ?? contact.name ?? "this contact";
            if (!window.confirm(`Send a Partner Portal invite to ${label}?`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="orgContactId" value={contact.id} />

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Name</span>
            <input
              name="name"
              defaultValue={contact.name}
              required
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Email</span>
            <input
              name="email"
              type="email"
              defaultValue={contact.email ?? ""}
              placeholder="name@company.com"
              required
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Phone (optional)</span>
            <input
              name="phone"
              type="tel"
              defaultValue={contact.phoneE164 ?? contact.phone ?? ""}
              placeholder="+1 404-555-1234"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>

          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">Invite includes a login link (expires in ~30 minutes).</span>
            <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Sending...">
              Send portal invite
            </SubmitButton>
          </div>
        </form>
      </div>

      {showBookingForm ? (
        <form action={bookAppointmentAction} className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
          <input type="hidden" name="contactId" value={contact.id} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Property</span>
              <select
                name="propertyId"
                defaultValue={primaryPropertyId}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="">No address yet (create placeholder)</option>
                {(contact.properties ?? []).map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.addressLine1}, {property.city}, {property.state} {property.postalCode}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Start time</span>
              <input
                type="datetime-local"
                name="startAt"
                required
                step={300}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Duration (minutes)</span>
              <input
                name="durationMinutes"
                type="number"
                min={15}
                step={5}
                defaultValue={60}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Travel buffer (minutes)</span>
              <input
                name="travelBufferMinutes"
                type="number"
                min={0}
                step={5}
                defaultValue={30}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quoted price (optional)</span>
              <input
                name="quotedTotal"
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 350"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Appointment notes (optional)</span>
              <textarea
                name="notes"
                rows={3}
                placeholder="What did they say? Parking/gate notes? Items? Time constraints?"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Booking...">
              Confirm booking
            </SubmitButton>
            <button type="button" className={teamButtonClass("secondary", "sm")} onClick={() => setShowBookingForm(false)}>
              Cancel
            </button>
            <span className="text-[11px] text-slate-500">Calendar sync runs via the outbox worker.</span>
          </div>
        </form>
      ) : null}

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

      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Address</div>
            <div className="text-sm font-semibold text-slate-900">Properties</div>
          </div>
          {addingProperty ? null : (
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                setAddingProperty(true);
                setEditingPropertyId(null);
              }}
            >
              Add property
            </button>
          )}
        </div>

        <div className="mt-3 space-y-3">
          {(contact.properties ?? []).map((property) => {
            const isEditing = editingPropertyId === property.id;
            return (
              <div key={property.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="text-xs text-slate-600">
                    <div className="text-sm font-semibold text-slate-900">
                      {property.addressLine1}
                      {property.addressLine2 ? `, ${property.addressLine2}` : ""}
                    </div>
                    <div>
                      {property.city}, {property.state} {property.postalCode}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">Added {formatDateTime(property.createdAt)}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      className={`${teamButtonClass("secondary", "sm")} ${buildMapsLinkForProperty(property) ? "" : "pointer-events-none opacity-50"}`}
                      href={buildMapsLinkForProperty(property) ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Maps
                    </a>
                    {isEditing ? (
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => setEditingPropertyId(null)}
                      >
                        Close
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => {
                          setAddingProperty(false);
                          setEditingPropertyId(property.id);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    <form
                      action={deletePropertyAction}
                      onSubmit={(event) => {
                        if (!window.confirm("Delete this property address?")) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="contactId" value={contact.id} />
                      <input type="hidden" name="propertyId" value={property.id} />
                      <SubmitButton className={teamButtonClass("danger", "sm")} pendingLabel="Deleting...">
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
                </div>

                {isEditing ? (
                  <form
                    action={updatePropertyAction}
                    className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 sm:grid-cols-2"
                    onSubmit={() => setEditingPropertyId(null)}
                  >
                    <input type="hidden" name="contactId" value={contact.id} />
                    <input type="hidden" name="propertyId" value={property.id} />
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span>Address line 1</span>
                      <input name="addressLine1" defaultValue={property.addressLine1} required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                    </label>
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span>Address line 2</span>
                      <input name="addressLine2" defaultValue={property.addressLine2 ?? ""} className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span>City</span>
                      <input name="city" defaultValue={property.city} required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <span>State</span>
                        <input name="state" defaultValue={property.state} required maxLength={2} className="rounded-xl border border-slate-200 bg-white px-3 py-2 uppercase" />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>Postal code</span>
                        <input name="postalCode" defaultValue={property.postalCode} required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                        Save
                      </SubmitButton>
                      <button type="button" className={teamButtonClass("secondary", "sm")} onClick={() => setEditingPropertyId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            );
          })}

          {addingProperty ? (
            <form
              action={addPropertyAction}
              className="grid grid-cols-1 gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-600 sm:grid-cols-2"
              onSubmit={() => setAddingProperty(false)}
            >
              <input type="hidden" name="contactId" value={contact.id} />
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span>Address line 1</span>
                <input name="addressLine1" required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span>Address line 2</span>
                <input name="addressLine2" className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              </label>
              <label className="flex flex-col gap-1">
                <span>City</span>
                <input name="city" required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span>State</span>
                  <input name="state" required maxLength={2} className="rounded-xl border border-slate-200 bg-white px-3 py-2 uppercase" />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Postal code</span>
                  <input name="postalCode" required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                </label>
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                  Save
                </SubmitButton>
                <button type="button" className={teamButtonClass("secondary", "sm")} onClick={() => setAddingProperty(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {!addingProperty && (contact.properties ?? []).length === 0 ? (
            <div className="text-xs text-slate-500">No address yet. Add a property to save the job location.</div>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Instant Quote</div>
            <div className="text-sm font-semibold text-slate-900">Quote photos</div>
          </div>
          <div className="text-xs text-slate-500">{quotePhotoUrls.length ? `${quotePhotoUrls.length} photo(s)` : ""}</div>
        </div>
        <div className="mt-3 text-xs text-slate-600">
          {quotePhotosStatus === "loading" ? (
            <div>Loading photos…</div>
          ) : quotePhotosStatus === "error" ? (
            <div className="text-rose-600">Unable to load quote photos.</div>
          ) : quotePhotoUrls.length === 0 ? (
            <div>No quote photos on file yet.</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {quotePhotoUrls.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt="Quote photo"
                    className="h-28 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                  />
                </a>
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-500">Photos can expire after 7 days.</div>
        </div>
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
