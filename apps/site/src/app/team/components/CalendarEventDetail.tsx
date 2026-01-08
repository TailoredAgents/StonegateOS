import React from "react";
import type { CalendarEvent } from "./CalendarGrid";
import { TEAM_TIME_ZONE } from "../lib/timezone";

type Props = {
  event: CalendarEvent;
};

export function CalendarEventDetail({ event }: Props): React.ReactElement {
  const appointmentId =
    event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : null);
  const rescheduleLink =
    appointmentId && event.rescheduleToken
      ? `/schedule?appointmentId=${encodeURIComponent(appointmentId)}&token=${encodeURIComponent(event.rescheduleToken)}`
      : null;
  const teamLink = appointmentId ? `/team?tab=myday&appointmentId=${encodeURIComponent(appointmentId)}` : null;
  const notes = event.notes ?? [];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-700">
          {event.source === "db" ? "Appointment" : "Google"}
        </span>
        {event.status ? (
          <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-semibold uppercase text-primary-700">
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
