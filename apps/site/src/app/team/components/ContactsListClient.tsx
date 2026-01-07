'use client';

import { useEffect, useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  PIPELINE_STAGES,
  badgeClassForPipelineStage,
  labelForPipelineStage
} from "./pipeline.stages";
import {
  addPropertyAction,
  bookAppointmentAction,
  createContactNoteAction,
  deleteContactAction,
  deleteContactNoteAction,
  deletePropertyAction,
  startContactCallAction,
  updateContactAction,
  updatePipelineStageAction,
  updatePropertyAction
} from "../actions";
import type { ContactNoteSummary, ContactSummary, PropertySummary } from "./contacts.types";

function formatDateTime(iso: string | null): string {
  if (!iso) return "N/A";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function mapsUrl(property: PropertySummary | undefined): string | null {
  if (!property) return null;
  const parts = [
    property.addressLine1,
    property.addressLine2 ?? "",
    `${property.city}, ${property.state} ${property.postalCode}`
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

function normalizePhoneLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.length ? cleaned : null;
}

function teamLink(tab: string, params?: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  query.set("tab", tab);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.trim().length > 0) {
        query.set(key, value.trim());
      }
    }
  }
  return `/team?${query.toString()}`;
}

type ContactCardProps = {
  contact: ContactSummary;
};

function ContactCard({ contact }: ContactCardProps) {
  const [contactState, setContactState] = useState<ContactSummary>(contact);
  const [editingContact, setEditingContact] = useState(false);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [bookingStartAtIso, setBookingStartAtIso] = useState<string>("");
  const [addingProperty, setAddingProperty] = useState(false);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [showNoteForm, setShowNoteForm] = useState(false);

  useEffect(() => {
    setContactState(contact);
  }, [contact]);

  const primaryProperty = contactState.properties[0];
  const mapsLink = mapsUrl(primaryProperty);
  const phoneLink = normalizePhoneLink(contactState.phone);
  const callLink = phoneLink ? `tel:${phoneLink}` : null;
  const textLink = phoneLink ? `sms:${phoneLink}` : null;

  const sortedNotes = useMemo(() => {
    return [...(contactState.notes ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [contactState.notes]);

  return (
    <li className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <h3 className="text-lg font-semibold text-slate-900">{contactState.name}</h3>
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(
                  contactState.pipeline.stage
                )}`}
              >
                {labelForPipelineStage(contactState.pipeline.stage)}
              </span>
            </div>
            <form action={updatePipelineStageAction} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <input type="hidden" name="contactId" value={contactState.id} />
              <label className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-slate-500">Stage</span>
                <select
                  name="stage"
                  defaultValue={contactState.pipeline.stage}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
                >
                  {PIPELINE_STAGES.map((value) => (
                    <option key={value} value={value}>
                      {labelForPipelineStage(value)}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton
                className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:border-primary-300 hover:text-primary-700"
                pendingLabel="Saving..."
              >
                Update
              </SubmitButton>
            </form>
            <div className="flex flex-wrap gap-3 text-xs text-slate-500">
              {contactState.email ? (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1">{contactState.email}</span>
              ) : null}
              {contactState.phone ? (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1">{contactState.phone}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1">
                Appointments: {contactState.stats.appointments}
              </span>
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1">
                Quotes: {contactState.stats.quotes}
              </span>
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1">
                Notes: {contactState.notesCount ?? contactState.notes.length}
              </span>
            </div>
            <p className="text-xs text-slate-400">Last activity: {formatDateTime(contactState.lastActivityAt)}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
              onClick={() => setEditingContact((prev) => !prev)}
            >
              {editingContact ? "Close edit" : "Edit contact"}
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
              onClick={() => setShowBookingForm((prev) => !prev)}
            >
              {showBookingForm ? "Close booking" : "Book appointment"}
            </button>
            <form action={deleteContactAction} className="inline">
              <input type="hidden" name="contactId" value={contactState.id} />
              <SubmitButton className="rounded-full border border-rose-200 px-4 py-2 font-medium text-rose-600 transition hover:bg-rose-50" pendingLabel="Removing...">
                Delete
              </SubmitButton>
            </form>
            <form
              action={startContactCallAction}
              className="inline"
              onSubmit={(event) => {
                if (!callLink) {
                  event.preventDefault();
                  return;
                }
                const label = contactState.phone ?? "this contact";
                if (!window.confirm(`Call ${contactState.name} (${label}) from the Stonegate number?`)) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="contactId" value={contactState.id} />
              <SubmitButton
                className={`rounded-full border px-4 py-2 font-medium ${
                  callLink
                    ? "border-primary-200 bg-primary-50 text-primary-800 hover:border-primary-300 hover:bg-primary-100"
                    : "border-slate-100 text-slate-300"
                }`}
                pendingLabel="Calling..."
                disabled={!callLink}
              >
                Call
              </SubmitButton>
            </form>
            <a
              className={`rounded-full border px-4 py-2 font-medium ${
                textLink
                  ? "border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-700"
                  : "pointer-events-none border-slate-100 text-slate-300"
              }`}
              href={textLink ?? "#"}
            >
              Text
            </a>
            <a
              className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
              href={teamLink("quote-builder", { contactId: contactState.id })}
            >
              Create quote
            </a>
            <a
              className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
              href={teamLink("myday", { contactId: contactState.id })}
            >
              Schedule visit
            </a>
            <a
              className={`rounded-full border px-4 py-2 font-medium ${
                mapsLink ? "border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none border-slate-100 text-slate-300"
              }`}
              href={mapsLink ?? "#"}
              target="_blank"
              rel="noreferrer"
            >
              Open in Maps
            </a>
          </div>
        </div>

        {editingContact ? (
          <form
            action={updateContactAction}
            className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-xs text-slate-600 shadow-inner"
            onSubmit={() => setEditingContact(false)}
          >
            <input type="hidden" name="contactId" value={contactState.id} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>First name</span>
                <input
                  name="firstName"
                  defaultValue={contactState.firstName}
                  required
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Last name</span>
                <input
                  name="lastName"
                  defaultValue={contactState.lastName}
                  required
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Email</span>
                <input name="email" defaultValue={contactState.email ?? ""} className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              </label>
              <label className="flex flex-col gap-1">
                <span>Phone</span>
                <input name="phone" defaultValue={contactState.phone ?? ""} className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              </label>
            </div>
            <div className="flex gap-2">
              <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Saving...">
                Save changes
              </SubmitButton>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                onClick={() => setEditingContact(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {showBookingForm ? (
          <form
            action={bookAppointmentAction}
            className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-xs text-slate-600 shadow-inner"
            onSubmit={() => {
              setShowBookingForm(false);
              setBookingStartAtIso("");
            }}
          >
            <input type="hidden" name="contactId" value={contactState.id} />
            <input type="hidden" name="startAt" value={bookingStartAtIso} />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>Property</span>
                <select
                  name="propertyId"
                  defaultValue={primaryProperty?.id ?? ""}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                >
                  <option value="">
                    No address yet (create placeholder)
                  </option>
                  {contactState.properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.addressLine1}, {property.city}, {property.state} {property.postalCode}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span>Start time</span>
                <input
                  type="datetime-local"
                  required
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      setBookingStartAtIso("");
                      return;
                    }
                    const parsed = new Date(value);
                    setBookingStartAtIso(Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString());
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Duration (minutes)</span>
                <input
                  name="durationMinutes"
                  type="number"
                  min={15}
                  step={5}
                  defaultValue={60}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Travel buffer (minutes)</span>
                <input
                  name="travelBufferMinutes"
                  type="number"
                  min={0}
                  step={5}
                  defaultValue={30}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                />
              </label>
               <label className="flex flex-col gap-1 sm:col-span-2">
                 <span>Services (optional)</span>
                 <input
                   name="services"
                   placeholder="e.g. junk_removal_primary"
                   className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                 />
               </label>
               <label className="flex flex-col gap-1 sm:col-span-2">
                 <span>Quoted price (optional)</span>
                 <input
                   name="quotedTotal"
                   type="number"
                   min={0}
                   step="0.01"
                   placeholder="e.g. 350"
                   className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                 />
               </label>
             </div>
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Booking...">
                Confirm booking (adds to calendar)
              </SubmitButton>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                onClick={() => {
                  setShowBookingForm(false);
                  setBookingStartAtIso("");
                }}
              >
                Cancel
              </button>
              <span className="text-[11px] text-slate-500">
                Calendar sync runs via the outbox worker.
              </span>
            </div>
          </form>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-inner">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">Properties</h4>
                {addingProperty ? null : (
                  <button
                    type="button"
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-primary-300 hover:text-primary-700"
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
                {contactState.properties.map((property) => (
                  <div key={property.id} className="rounded-2xl border border-white/60 bg-white/90 p-4 shadow-sm shadow-slate-200/40">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1 text-sm text-slate-600">
                        <p className="font-medium text-slate-800">
                          {property.addressLine1}
                          {property.addressLine2 ? `, ${property.addressLine2}` : ""}
                        </p>
                        <p>
                          {property.city}, {property.state} {property.postalCode}
                        </p>
                        <p className="text-xs text-slate-400">Added {formatDateTime(property.createdAt)}</p>
                      </div>
                      <div className="flex gap-2 text-xs">
                        <button
                          type="button"
                          className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:border-primary-300 hover:text-primary-700"
                          onClick={() => {
                            setEditingPropertyId((current) => (current === property.id ? null : property.id));
                            setAddingProperty(false);
                          }}
                        >
                          {editingPropertyId === property.id ? "Close" : "Edit"}
                        </button>
                        <form action={deletePropertyAction}>
                          <input type="hidden" name="contactId" value={contactState.id} />
                          <input type="hidden" name="propertyId" value={property.id} />
                          <SubmitButton className="rounded-full border border-rose-200 px-3 py-1.5 font-medium text-rose-600 hover:bg-rose-50" pendingLabel="Removing...">
                            Delete
                          </SubmitButton>
                        </form>
                      </div>
                    </div>
                    {editingPropertyId === property.id ? (
                      <form
                        action={updatePropertyAction}
                        className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 sm:grid-cols-2"
                        onSubmit={() => setEditingPropertyId(null)}
                      >
                        <input type="hidden" name="contactId" value={contactState.id} />
                        <input type="hidden" name="propertyId" value={property.id} />
                        <label className="flex flex-col gap-1">
                          <span>Address line 1</span>
                          <input name="addressLine1" defaultValue={property.addressLine1} required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                        </label>
                        <label className="flex flex-col gap-1">
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
                        <div className="flex gap-2 sm:col-span-2">
                          <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Saving...">
                            Save property
                          </SubmitButton>
                          <button
                            type="button"
                            className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                            onClick={() => setEditingPropertyId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                ))}
              </div>
              {addingProperty ? (
                <form
                  action={addPropertyAction}
                  className="mt-4 grid grid-cols-1 gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4 text-xs text-slate-600 shadow-inner sm:grid-cols-2"
                  onSubmit={() => setAddingProperty(false)}
                >
                  <input type="hidden" name="contactId" value={contactState.id} />
                  <label className="flex flex-col gap-1">
                    <span>Address line 1</span>
                    <input name="addressLine1" required className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
                  </label>
                  <label className="flex flex-col gap-1">
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
                  <div className="flex gap-2 sm:col-span-2">
                    <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Saving...">
                      Save property
                    </SubmitButton>
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                      onClick={() => setAddingProperty(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>

          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 shadow-inner">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">Notes</h4>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-primary-300 hover:text-primary-700"
                  onClick={() => setShowNoteForm((prev) => !prev)}
                >
                  {showNoteForm ? "Close" : "Add note"}
                </button>
              </div>
              <div className="mt-3 space-y-3">
                {sortedNotes.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-200 bg-white/60 px-3 py-2 text-xs text-slate-500">
                    No notes yet. Capture details from calls and follow-ups so everyone stays aligned.
                  </p>
                ) : (
                  sortedNotes.map((note) => <NoteRow key={note.id} note={note} />)
                )}
              </div>
              {showNoteForm ? (
                <form
                  action={createContactNoteAction}
                  className="mt-4 grid grid-cols-1 gap-3 text-xs text-slate-600"
                >
                  <input type="hidden" name="contactId" value={contactState.id} />
                  <label className="flex flex-col gap-1">
                    <span>Note</span>
                    <textarea
                      name="body"
                      required
                      rows={3}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                      placeholder="What happened? Next steps?"
                    />
                  </label>
                  <div className="flex gap-2">
                    <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Saving...">
                      Add note
                    </SubmitButton>
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                      onClick={() => setShowNoteForm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function NoteRow({ note }: { note: ContactNoteSummary }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-xs text-slate-700 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-[11px] text-slate-500">Added {formatDateTime(note.createdAt)}</p>
          <p className="whitespace-pre-wrap text-sm font-semibold text-slate-800">{note.body}</p>
        </div>
        <form
          action={deleteContactNoteAction}
          onSubmit={(event) => {
            if (!window.confirm("Delete this note?")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="noteId" value={note.id} />
          <SubmitButton className="rounded-full border border-rose-200 px-3 py-1.5 font-medium text-rose-600 hover:bg-rose-50" pendingLabel="Removing...">
            Delete
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

export default function ContactsListClient({ contacts }: { contacts: ContactSummary[] }) {
  return (
    <ul className="space-y-4">
      {contacts.map((contact) => (
        <ContactCard key={contact.id} contact={contact} />
      ))}
    </ul>
  );
}
