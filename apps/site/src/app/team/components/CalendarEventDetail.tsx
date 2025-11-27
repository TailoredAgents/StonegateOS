import React from "react";
import type { CalendarEvent } from "./CalendarGrid";

type Props = {
  event: CalendarEvent;
};

export function CalendarEventDetail({ event }: Props): React.ReactElement {
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
        {formatTime(event.start)} – {formatTime(event.end)}
      </p>
      {event.address ? <p className="text-xs text-slate-500">{event.address}</p> : null}
      {event.contactName ? <p className="text-xs text-slate-500">Contact: {event.contactName}</p> : null}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
