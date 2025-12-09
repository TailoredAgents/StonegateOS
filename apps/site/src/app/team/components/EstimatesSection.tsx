import React, { type ReactElement } from "react";
import { availabilityWindows, zones } from "@myst-os/pricing/src/config/defaults";
import { SubmitButton } from "@/components/SubmitButton";
import {
  createQuoteAction,
  rescheduleAppointmentAction,
  updateApptStatus,
  addApptNote
} from "../actions";
import { addApptAttachmentAction } from "../actions/attachments";
import { callAdminApi, fmtTime } from "../lib/api";

type AppointmentStatus = "requested" | "confirmed" | "completed" | "no_show" | "canceled";

interface AppointmentDto {
  id: string;
  status: AppointmentStatus;
  startAt: string | null;
  contact: { id: string | null; name: string };
  property: { id: string | null; addressLine1: string; city: string; state: string; postalCode: string };
  services: string[];
  pipelineStage: string | null;
  quoteStatus: string | null;
  rescheduleToken: string;
  crew: string | null;
  owner: string | null;
  notes: Array<{ id: string; body: string; createdAt: string }>;
  attachments: Array<{ id: string; filename: string; url: string; contentType: string | null; createdAt: string }>;
}

const CREW_OPTIONS = ["Crew 1", "Crew 2"];
const OWNER_OPTIONS = ["Austin", "Jeffery", "Conner"];

export async function EstimatesSection(): Promise<ReactElement> {
  const res = await callAdminApi("/api/appointments?status=all");
  if (!res.ok) {
    throw new Error("Failed to load appointments");
  }

  const payload = (await res.json()) as { ok: boolean; data: AppointmentDto[] };
  const byStatus: Record<AppointmentStatus, AppointmentDto[]> = {
    requested: [],
    confirmed: [],
    completed: [],
    no_show: [],
    canceled: []
  };
  for (const appt of payload.data ?? []) {
    if (byStatus[appt.status]) {
      byStatus[appt.status].push(appt);
    }
  }

  const columns: AppointmentStatus[] = ["requested", "confirmed", "completed", "no_show"];
  const upcoming = (payload.data ?? [])
    .filter((a) => a.startAt)
    .sort((a, b) => (a.startAt && b.startAt ? a.startAt.localeCompare(b.startAt) : 0))
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {columns.map((status) => (
        <div key={status} className="rounded-lg border border-neutral-200 bg-white shadow-sm">
          <header className="border-b border-neutral-200 px-4 py-2">
            <h3 className="text-sm font-semibold text-primary-900 capitalize">{status.replace("_", " ")}</h3>
            <p className="text-xs text-neutral-500">{byStatus[status].length} appointment(s)</p>
          </header>
          <ul className="divide-y divide-neutral-200">
            {byStatus[status].map((a) => (
              <li key={a.id} className="px-4 py-3">
                <p className="text-sm text-neutral-600">
                  {fmtTime(a.startAt)} • {a.contact.name}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                    Crew: {a.crew ?? "Unassigned"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">
                    Owner: {a.owner ?? "Unassigned"}
                  </span>
                  {a.pipelineStage ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-semibold text-neutral-700">
                      Pipeline: {a.pipelineStage}
                    </span>
                  ) : null}
                  {a.quoteStatus ? (
                    <span className="rounded-full bg-primary-50 px-2 py-0.5 font-semibold text-primary-700">
                      Quote: {a.quoteStatus}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <form action={updateApptStatus} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="status" value={a.status} />
                    <label className="text-[11px] text-neutral-600">
                      Crew
                      <select
                        name="crew"
                        defaultValue={a.crew ?? ""}
                        className="ml-2 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                      >
                        <option value="">Unassigned</option>
                        {CREW_OPTIONS.map((crew) => (
                          <option key={crew} value={crew}>
                            {crew}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] text-neutral-600">
                      Owner
                      <select
                        name="owner"
                        defaultValue={a.owner ?? "Austin"}
                        className="ml-2 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                      >
                        {OWNER_OPTIONS.map((owner) => (
                          <option key={owner} value={owner}>
                            {owner}
                          </option>
                        ))}
                      </select>
                    </label>
                    <SubmitButton className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-700" pendingLabel="Saving...">
                      Save assignment
                    </SubmitButton>
                  </form>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {status === "requested" ? (
                    <>
                      <form action={updateApptStatus}>
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="status" value="confirmed" />
                        <SubmitButton className="rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Saving...">
                          Assign / Confirm
                        </SubmitButton>
                      </form>
                      <form action={updateApptStatus}>
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="status" value="canceled" />
                        <SubmitButton className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600" pendingLabel="Saving...">
                          Cancel
                        </SubmitButton>
                      </form>
                    </>
                  ) : null}
                  {status === "confirmed" ? (
                    <>
                      <form action={updateApptStatus}>
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="status" value="completed" />
                        <SubmitButton className="rounded-full bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Saving...">
                          Mark complete
                        </SubmitButton>
                      </form>
                      <form action={updateApptStatus}>
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="status" value="no_show" />
                        <SubmitButton className="rounded-full border border-warning px-3 py-1 text-xs text-warning" pendingLabel="Saving...">
                          No-show
                        </SubmitButton>
                      </form>
                    </>
                  ) : null}
                </div>

                {a.notes.length ? (
                  <div className="mt-2 space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
                    <div className="text-[11px] font-semibold uppercase text-neutral-500">Notes</div>
                    {a.notes.map((note) => (
                      <div key={note.id} className="rounded-md bg-white px-2 py-1">
                        <div>{note.body}</div>
                        <div className="text-[10px] text-neutral-400">{new Date(note.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {a.attachments.length ? (
                  <div className="mt-2 space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
                    <div className="text-[11px] font-semibold uppercase text-neutral-500">Attachments</div>
                    {a.attachments.map((att) => (
                      <div key={att.id} className="flex items-center justify-between rounded-md bg-white px-2 py-1">
                        <a
                          href={att.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary-700 underline"
                          title={att.filename}
                        >
                          {att.filename}
                        </a>
                        <div className="text-[10px] text-neutral-400">{new Date(att.createdAt).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <details className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">Add note</summary>
                  <form action={addApptNote} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <label className="flex flex-col gap-1">
                      <span>Note</span>
                      <textarea name="body" rows={2} className="rounded-md border border-neutral-300 px-2 py-1" required></textarea>
                    </label>
                    <SubmitButton className="self-start rounded-md bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Saving...">
                      Save note
                    </SubmitButton>
                  </form>
                </details>
                <details className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">Add attachment (upload)</summary>
                  <form action={addApptAttachmentAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <label className="flex flex-col gap-1">
                      <span>File</span>
                      <input
                        type="file"
                        name="file"
                        required
                        className="rounded-md border border-neutral-300 px-2 py-1"
                        accept="image/*,application/pdf"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span>File name (optional override)</span>
                      <input
                        type="text"
                        name="filename"
                        className="rounded-md border border-neutral-300 px-2 py-1"
                        placeholder="before-after.jpg"
                      />
                    </label>
                    <SubmitButton className="self-start rounded-md bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Saving...">
                      Save attachment
                    </SubmitButton>
                  </form>
                </details>

                <details className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">Reschedule</summary>
                  <form action={rescheduleAppointmentAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <label className="flex flex-col gap-1">
                      <span>Date</span>
                      <input
                        type="date"
                        name="preferredDate"
                        defaultValue={a.startAt ? a.startAt.slice(0, 10) : ""}
                        required
                        className="rounded-md border border-neutral-300 px-2 py-1"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span>Time window</span>
                      <select name="timeWindow" defaultValue="" className="rounded-md border border-neutral-300 px-2 py-1" required>
                        <option value="" disabled>
                          Select window
                        </option>
                        {availabilityWindows.map((window) => (
                          <option key={window.id} value={window.id}>
                            {window.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <SubmitButton className="self-start rounded-md bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Saving...">
                      Save new time
                    </SubmitButton>
                  </form>
                </details>

                {a.contact.id && a.property.id ? (
                  <details className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
                    <summary className="cursor-pointer text-xs font-medium text-neutral-700">Create quote</summary>
                    <form action={createQuoteAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <input type="hidden" name="contactId" value={a.contact.id} />
                      <input type="hidden" name="propertyId" value={a.property.id} />
                      <input type="hidden" name="services" value={JSON.stringify(a.services ?? [])} />
                      <label className="flex flex-col gap-1">
                        <span>Zone</span>
                        <select name="zoneId" defaultValue={zones[0]?.id ?? "zone-core"} className="rounded-md border border-neutral-300 px-2 py-1" required>
                          {zones.map((zone) => (
                            <option key={zone.id} value={zone.id}>
                              {zone.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {/* Removed surface area, concrete inputs, and bundle toggle for junk removal */}
                      <label className="flex flex-col gap-1">
                        <span>Notes</span>
                        <textarea name="notes" rows={3} placeholder="Optional quote notes" className="rounded-md border border-neutral-300 px-2 py-1"></textarea>
                      </label>
                      <SubmitButton className="self-start rounded-md bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Creating...">
                        Create quote
                      </SubmitButton>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      </section>

      <section className="rounded-lg border border-primary-100 bg-primary-50/60 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-primary-900">Routing preview</h3>
            <p className="text-xs text-primary-700">Next 8 estimates with map links when available.</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {upcoming.map((a) => (
            <div key={a.id} className="rounded-md border border-white/60 bg-white/90 p-3 shadow-sm">
              <div className="text-[11px] font-semibold uppercase text-primary-700">{fmtTime(a.startAt)}</div>
              <div className="text-sm font-semibold text-primary-900">{a.contact.name}</div>
              <div className="text-xs text-neutral-600">
                {a.property.addressLine1}, {a.property.city}, {a.property.state} {a.property.postalCode}
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-neutral-600">
                <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">Crew: {a.crew ?? "Unassigned"}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">Owner: {a.owner ?? "Unassigned"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {a.property.addressLine1 ? (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                      `${a.property.addressLine1}, ${a.property.city}, ${a.property.state} ${a.property.postalCode}`
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-primary-100 px-2 py-1 font-semibold text-primary-800"
                  >
                    Open Map
                  </a>
                ) : (
                  <span className="text-neutral-500">No map</span>
                )}
              </div>
            </div>
          ))}
          {upcoming.length === 0 ? <p className="text-xs text-neutral-600">No upcoming estimates.</p> : null}
        </div>
      </section>
    </div>
  );
}
