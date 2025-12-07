import React from "react";

export type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  onSelectEvent?: (id: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarGrid({ events, conflicts, onSelectEvent }: Props): React.ReactElement {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }).map((_, i) => new Date(startOfWeek.getTime() + i * DAY_MS));

  const dayBuckets: Record<string, CalendarEvent[]> = {};
  for (const day of days) {
    dayBuckets[day.toISOString().slice(0, 10)] = [];
  }

  for (const evt of events) {
    const dayKey = new Date(evt.start).toISOString().slice(0, 10);
    if (dayBuckets[dayKey]) {
      dayBuckets[dayKey].push(evt);
    }
  }

  const isConflict = (id: string) => conflicts.some((c) => c.a === id || c.b === id);

  return (
    <div className="grid grid-cols-7 gap-2 text-sm">
      {days.map((day) => {
        const key = day.toISOString().slice(0, 10);
        const bucket = dayBuckets[key] ?? [];
        return (
          <div key={key} className="rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm">
            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
              {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <div className="space-y-2">
              {bucket.length === 0 ? (
                <p className="text-xs text-slate-400">Empty</p>
              ) : (
                bucket
                  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                  .map((evt) => (
                    <button
                      key={evt.id}
                      className={`rounded-lg border px-2 py-1 ${
                        evt.source === "db" ? "border-primary-200 bg-primary-50/70" : "border-slate-200 bg-slate-50"
                      } ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                      onClick={() => onSelectEvent?.(evt.id)}
                      type="button"
                    >
                      <div className="flex items-center gap-1 text-[11px] text-slate-600">
                        <span className="font-semibold text-slate-800">
                          {formatTime(evt.start)} - {formatTime(evt.end)}
                        </span>
                        <span className="rounded-full bg-white px-1.5 text-[10px] uppercase text-slate-500">
                          {evt.source === "db" ? "appt" : "google"}
                        </span>
                        {evt.status ? (
                          <span className="rounded-full bg-white px-1.5 text-[10px] uppercase text-primary-700">
                            {evt.status}
                          </span>
                        ) : null}
                        {isConflict(evt.id) ? (
                          <span className="rounded-full bg-rose-100 px-1.5 text-[10px] uppercase text-rose-700">
                            conflict
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs font-semibold text-slate-900">{evt.title}</div>
                      {evt.address ? <div className="text-[11px] text-slate-500">{evt.address}</div> : null}
                    </button>
                  ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
