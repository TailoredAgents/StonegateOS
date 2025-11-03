import React, { type ReactElement } from "react";
import { availabilityWindows, zones } from "@myst-os/pricing/src/config/defaults";
import { SubmitButton } from "@/components/SubmitButton";
import {
  createQuoteAction,
  rescheduleAppointmentAction,
  updateApptStatus
} from "../actions";
import { callAdminApi, fmtTime } from "../lib/api";

type AppointmentStatus = "requested" | "confirmed" | "completed" | "no_show" | "canceled";

interface AppointmentDto {
  id: string;
  status: AppointmentStatus;
  startAt: string | null;
  contact: { id: string | null; name: string };
  property: { id: string | null; addressLine1: string; city: string; state: string; postalCode: string };
  services: string[];
  rescheduleToken: string;
}

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

  return (
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
  );
}
