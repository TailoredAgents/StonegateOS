import React, { type ReactElement } from "react";
import { availabilityWindows, zones } from "@myst-os/pricing/src/config/defaults";
import { CopyButton } from "@/components/CopyButton";
import { SubmitButton } from "@/components/SubmitButton";
import { summarizeServiceLabels } from "@/lib/service-labels";
import {
  createQuoteAction,
  rescheduleAppointmentAction,
  startContactCallAction
} from "../actions";
import { callAdminApi, fmtTime } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { labelForPipelineStage } from "./pipeline.stages";
import { TEAM_EMPTY_STATE, teamButtonClass } from "./team-ui";

type AppointmentStatus = "requested" | "confirmed" | "completed" | "no_show" | "canceled";

function fmtUsdCents(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  } catch {
    return `$${(value / 100).toFixed(2)}`;
  }
}

interface AppointmentDto {
  id: string;
  status: AppointmentStatus;
  startAt: string | null;
  durationMinutes: number | null;
  travelBufferMinutes: number | null;
  quotedTotalCents: number | null;
  finalTotalCents: number | null;
  services: string[];
  rescheduleToken: string;
  contact: {
    id: string | null;
    name: string;
    email: string | null;
    phone: string | null;
  };
  pipelineStage: string | null;
  quoteStatus: string | null;
  property: {
    id: string | null;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
  notes: Array<{ id: string; body: string; createdAt: string }>;
}

type TeamMemberDto = {
  id: string;
  name: string;
  defaultCrewSplitBps: number | null;
};

export async function MyDaySection(): Promise<ReactElement> {
  let appts: AppointmentDto[] = [];
  let loadError: string | null = null;
  let teamMembers: TeamMemberDto[] = [];
  try {
    const [res, membersRes] = await Promise.all([
      callAdminApi("/api/appointments?status=confirmed"),
      callAdminApi("/api/admin/team/directory")
    ]);

    if (!res.ok) {
      loadError = `Appointments request failed (HTTP ${res.status})`;
    } else {
      const payload = (await res.json()) as { ok: boolean; data: AppointmentDto[] };
      appts = (payload.data ?? []).sort((a, b) => {
        const ax = a.startAt ? Date.parse(a.startAt) : 0;
        const bx = b.startAt ? Date.parse(b.startAt) : 0;
        return ax - bx;
      });
    }

    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: TeamMemberDto[] };
      teamMembers = payload.members ?? [];
    }
  } catch (error) {
    loadError = `Appointments request error: ${(error as Error).message}`;
  }

  return (
    <section className="space-y-4">
      {loadError ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{loadError}</p>
      ) : null}
      {appts.length === 0 ? (
        <p className={TEAM_EMPTY_STATE}>
          No confirmed visits.
        </p>
      ) : (
        appts.map((a) => (
          <article key={a.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                Confirmed
              </span>
              <span>{fmtTime(a.startAt)}</span>
              <span aria-hidden="true">&bull;</span>
              <span>
                {summarizeServiceLabels(a.services ?? [])}
              </span>
            </div>
            <h3 className="mt-1 text-lg font-semibold text-primary-900">{a.contact.name}</h3>
            <p className="text-sm text-neutral-600">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${a.property.addressLine1}, ${a.property.city}, ${a.property.state} ${a.property.postalCode}`
                )}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {a.property.addressLine1}, {a.property.city}, {a.property.state} {a.property.postalCode}
              </a>
              <span className="ml-2 inline-block align-middle">
                <CopyButton
                  value={`${a.property.addressLine1}, ${a.property.city}, ${a.property.state} ${a.property.postalCode}`}
                  label="Copy"
                />
              </span>
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              {a.pipelineStage ? (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                  Pipeline: {labelForPipelineStage(a.pipelineStage)}
                </span>
              ) : null}
              {fmtUsdCents(a.quotedTotalCents) ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Quoted: {fmtUsdCents(a.quotedTotalCents)}
                </span>
              ) : null}
              {fmtUsdCents(a.finalTotalCents) ? (
                <span className="rounded-full bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                  Final: {fmtUsdCents(a.finalTotalCents)}
                </span>
              ) : null}
              {a.quoteStatus ? (
                <span className="rounded-full bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                  Quote: {a.quoteStatus}
                </span>
              ) : null}
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <form action="/api/team/appointments/status" method="post" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="appointmentId" value={a.id} />
                <input type="hidden" name="status" value="completed" />
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-neutral-600">Amount collected</span>
                  <input
                    name="finalTotal"
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    defaultValue={
                      a.finalTotalCents !== null
                        ? (a.finalTotalCents / 100).toFixed(2)
                        : a.quotedTotalCents !== null
                          ? (a.quotedTotalCents / 100).toFixed(2)
                          : ""
                    }
                    placeholder="e.g. 350.00"
                    className="w-40 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                  />
                </label>
                <details className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-700">
                  <summary className="cursor-pointer select-none font-medium">Commissions</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="text-[11px] text-neutral-600">
                      Sales commission comes from the contact&apos;s assigned salesperson.
                    </div>
                    <div className="text-[11px] text-neutral-600">Crew split (must total 100%)</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {teamMembers.map((member) => (
                        <label
                          key={member.id}
                          className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2 py-1"
                        >
                          <input
                            type="checkbox"
                            name="crewMemberId"
                            value={member.id}
                            className="h-4 w-4 rounded border-neutral-300"
                          />
                          <span className="flex-1 text-xs">{member.name}</span>
                          <input
                            name={`crewSplitPercent_${member.id}`}
                            defaultValue={
                              member.defaultCrewSplitBps !== null ? String(member.defaultCrewSplitBps / 100) : ""
                            }
                            inputMode="decimal"
                            placeholder="%"
                            className="w-16 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </details>
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                  Mark complete
                </SubmitButton>
              </form>
              <form action="/api/team/appointments/status" method="post">
                <input type="hidden" name="appointmentId" value={a.id} />
                <input type="hidden" name="status" value="no_show" />
                <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                  No-show
                </SubmitButton>
              </form>
              <a
                href={`/schedule?appointmentId=${encodeURIComponent(a.id)}&token=${encodeURIComponent(a.rescheduleToken)}`}
                className={teamButtonClass("secondary", "sm")}
              >
                Reschedule link
              </a>
            </div>

            <details className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
              <summary className="cursor-pointer text-sm font-medium text-neutral-700">Reschedule in console</summary>
              <form action={rescheduleAppointmentAction} className="mt-2 flex flex-col gap-2 text-xs">
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
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                  Save new time
                </SubmitButton>
              </form>
            </details>

            {a.contact.id && a.property.id ? (
              <details className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
                <summary className="cursor-pointer text-sm font-medium text-neutral-700">Create quote</summary>
                <form action={createQuoteAction} className="mt-2 flex flex-col gap-2 text-xs">
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
                  <label className="flex flex-col gap-1">
                    <span>General surface area (sq ft)</span>
                    <input type="number" name="surfaceArea" min="0" step="1" placeholder="Optional" className="rounded-md border border-neutral-300 px-2 py-1" />
                  </label>
                  <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
                    <span className="text-xs font-semibold text-neutral-700">Concrete surfaces (optional)</span>
                    {[1, 2, 3].map((index) => (
                      <div key={index} className="flex flex-col gap-2 sm:flex-row">
                        <select
                          name={`concreteSurface${index}Kind`}
                          defaultValue=""
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700"
                        >
                          <option value="">Select surface</option>
                          <option value="driveway">Driveway</option>
                          <option value="deck">Deck/Patio</option>
                          <option value="other">Other</option>
                        </select>
                        <input
                          name={`concreteSurface${index}Sqft`}
                          type="number"
                          min="0"
                          step="1"
                          placeholder="Sq ft"
                          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
                        />
                      </div>
                    ))}
                    <p className="text-[11px] text-neutral-500">Priced automatically at $0.14 per sq ft.</p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-neutral-700">
                    <input type="checkbox" name="applyBundles" defaultChecked className="rounded border-neutral-300" />
                    Apply bundle discounts
                  </label>
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

            <div className="mt-2 text-xs text-neutral-600">
              {a.contact.phone ? (
                <div className="flex flex-wrap items-center gap-2">
                  <form action={startContactCallAction}>
                    <input type="hidden" name="contactId" value={a.contact.id ?? ""} />
                    <SubmitButton
                      className={`${teamButtonClass("secondary", "sm")} px-3 py-1`}
                      pendingLabel="Calling..."
                      disabled={!a.contact.id}
                    >
                      Call
                    </SubmitButton>
                  </form>
                  <span className="text-xs text-neutral-600">{a.contact.phone}</span>
                  <span className="inline-block align-middle">
                    <CopyButton value={a.contact.phone} label="Copy" />
                  </span>
                </div>
              ) : null}
            </div>
            {a.notes.length ? (
              <div className="mt-3 space-y-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
                <div className="text-[11px] font-semibold uppercase text-neutral-500">Notes</div>
                {a.notes.map((note) => (
                  <div key={note.id} className="rounded-md bg-white px-2 py-1">
                    <div>{note.body}</div>
                    <div className="text-[10px] text-neutral-400">
                      {new Date(note.createdAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <form action="/api/team/appointments/notes" method="post" className="mt-3 flex gap-2">
              <input type="hidden" name="appointmentId" value={a.id} />
              <input name="body" placeholder="Add note" className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs" />
              <SubmitButton className="rounded-md bg-neutral-800 px-3 py-1 text-xs font-semibold text-white hover:bg-neutral-700" pendingLabel="Saving...">
                Save
              </SubmitButton>
            </form>
          </article>
        ))
      )}
    </section>
  );
}
