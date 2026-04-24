import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import type { CalendarEvent } from "./CalendarGrid";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { formatCalendarEventAmounts } from "./calendarEventAmounts";
import { CrewPayoutSelector } from "./CrewPayoutSelector";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

type Props = {
  event: CalendarEvent;
  teamMembers: Array<{ id: string; name: string }>;
  variant?: "standalone" | "embedded";
};

export function CalendarEventDetail({
  event,
  teamMembers,
  variant = "standalone",
}: Props): React.ReactElement {
  const isDbAppointment = event.source === "db";
  const isInPersonQuote =
    isDbAppointment &&
    (event.appointmentType ?? "").trim().toLowerCase() === "in_person_quote";
  const appointmentId =
    event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : null);
  const rescheduleLink =
    appointmentId && event.rescheduleToken
      ? `/schedule?appointmentId=${encodeURIComponent(appointmentId)}&token=${encodeURIComponent(event.rescheduleToken)}`
      : null;
  const teamLink = appointmentId ? `/team?tab=myday&appointmentId=${encodeURIComponent(appointmentId)}` : null;
  const notes = event.notes ?? [];
  const amountSummary = isDbAppointment ? formatCalendarEventAmounts(event) : null;
  const shellClass =
    variant === "embedded"
      ? "rounded-xl border border-slate-200 bg-white p-3"
      : "rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50";
  const normalizedStatus = (event.status ?? "").trim().toLowerCase();
  const canEditStatus =
    isDbAppointment &&
    appointmentId &&
    normalizedStatus !== "completed" &&
    normalizedStatus !== "canceled" &&
    normalizedStatus !== "no_show";
  const completeDefaultValue =
    event.finalTotalCents !== null && event.finalTotalCents !== undefined
      ? (event.finalTotalCents / 100).toFixed(2)
      : event.quotedTotalCents !== null && event.quotedTotalCents !== undefined
        ? (event.quotedTotalCents / 100).toFixed(2)
        : "";

  return (
    <div className={shellClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-700">
          {event.source === "db" ? "Appointment" : "Google"}
        </span>
        {isInPersonQuote ? (
          <span className="rounded-full bg-fuchsia-50 px-2 py-0.5 text-[11px] font-semibold uppercase text-fuchsia-700">
            In-person quote
          </span>
        ) : null}
        {event.status ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
              isInPersonQuote ? "bg-fuchsia-50 text-fuchsia-700" : "bg-primary-50 text-primary-700"
            }`}
          >
            {event.status}
          </span>
        ) : null}
      </div>
      <h3 className="mt-2 text-lg font-semibold text-slate-900">{event.title}</h3>
      <p className="text-sm text-slate-600">
        {formatTime(event.start)} - {formatTime(event.end)}
      </p>
      {event.address ? <p className="text-xs text-slate-500">{event.address}</p> : null}
      {event.contactName ? <p className="text-xs text-slate-500">Contact: {event.contactName}</p> : null}
      {amountSummary ? <p className="text-xs text-slate-500">{amountSummary}</p> : null}
      {notes.length ? (
        <div className="mt-3 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notes</div>
          {notes.map((note) => (
            <div key={note.id} className="rounded-lg bg-white px-3 py-2 shadow-sm">
              <div className="whitespace-pre-wrap text-sm font-semibold text-slate-900">{note.body}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                {new Date(note.createdAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {canEditStatus ? (
        <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Actions
          </div>

          {isInPersonQuote ? (
            <form action="/api/team/appointments/status" method="post">
              <input type="hidden" name="appointmentId" value={appointmentId ?? ""} />
              <input type="hidden" name="appointmentType" value={event.appointmentType ?? ""} />
              <input type="hidden" name="status" value="completed" />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-600">
                  Mark this in-person quote visit as done.
                </p>
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Saving..."
                >
                  Done
                </SubmitButton>
              </div>
            </form>
          ) : (
            <form
              action="/api/team/appointments/status"
              method="post"
              className="grid grid-cols-1 gap-3"
            >
              <input type="hidden" name="appointmentId" value={appointmentId ?? ""} />
              <input type="hidden" name="appointmentType" value={event.appointmentType ?? ""} />
              <input type="hidden" name="status" value="completed" />

              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Amount collected</span>
                <input
                  name="finalTotal"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  defaultValue={completeDefaultValue}
                  placeholder="e.g. 350.00"
                  className={TEAM_INPUT_COMPACT}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Card tips (optional)</span>
                <input
                  name="cardTip"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="e.g. 20.00"
                  className={TEAM_INPUT_COMPACT}
                />
              </label>

              <CrewPayoutSelector
                teamMembers={teamMembers}
                showSplitPercentages={false}
              />

              <div className="flex justify-end">
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Saving..."
                >
                  Complete job
                </SubmitButton>
              </div>
            </form>
          )}

          <form action="/api/team/appointments/status" method="post">
            <input type="hidden" name="appointmentId" value={appointmentId ?? ""} />
            <input type="hidden" name="appointmentType" value={event.appointmentType ?? ""} />
            <input type="hidden" name="status" value="canceled" />
            <SubmitButton
              className={teamButtonClass("danger", "sm")}
              pendingLabel="Saving..."
            >
              Cancel
            </SubmitButton>
          </form>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {teamLink ? (
          <a
            href={teamLink}
            className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-white"
          >
            Open in Team
          </a>
        ) : null}
        {rescheduleLink ? (
          <a
            href={rescheduleLink}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
          >
            Reschedule
          </a>
        ) : null}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
