import React from "react";
import { formatDayKey, TEAM_TIME_ZONE } from "../lib/timezone";

type CalendarEvent = {
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
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarMonthGrid({
  events,
  conflicts,
  onSelectEvent,
  selectedDay,
  onSelectDay
}: Props): React.ReactElement {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0 Sunday
  const startDate = new Date(firstOfMonth);
  startDate.setDate(firstOfMonth.getDate() - startOffset);
  const cells = Array.from({ length: 42 }).map((_, i) => new Date(startDate.getTime() + i * DAY_MS));

  const buckets = new Map<string, CalendarEvent[]>();
  for (const cell of cells) {
    buckets.set(formatDayKey(cell), []);
  }
  for (const evt of events) {
    const parsed = new Date(evt.start);
    const key = Number.isNaN(parsed.getTime()) ? "" : formatDayKey(parsed);
    if (buckets.has(key)) {
      buckets.get(key)!.push(evt);
    }
  }

  const isConflict = (id: string) => conflicts.some((c) => c.a === id || c.b === id);

  return (
    <div className="grid grid-cols-7 gap-2 text-sm">
      {cells.map((day, idx) => {
        const key = formatDayKey(day);
        const inMonth = day.getMonth() === month;
        const bucket = buckets.get(key) ?? [];
        const isSelected = typeof selectedDay === "string" && selectedDay.length > 0 ? selectedDay === key : false;
        return (
          <div
            key={key + idx}
            className={`min-h-[120px] min-w-0 overflow-hidden rounded-xl border p-2 ${
              inMonth ? "border-slate-200 bg-white/90" : "border-slate-100 bg-slate-50"
            } ${isSelected ? "ring-2 ring-primary-200" : ""}`}
          >
            <button
              type="button"
              onClick={() => onSelectDay?.(key)}
              className={`mb-1 w-full text-left text-[11px] font-semibold uppercase ${
                isSelected ? "text-primary-700" : "text-slate-500"
              }`}
            >
              {day.toLocaleDateString(undefined, {
                timeZone: TEAM_TIME_ZONE,
                weekday: "short",
                day: "numeric"
              })}
            </button>

            {bucket.length ? (
              <div className="flex flex-wrap items-center gap-1 sm:hidden" aria-label={`${bucket.length} events`}>
                {bucket.slice(0, 3).map((evt) => (
                  <span
                    key={evt.id}
                    className={`h-1.5 w-1.5 rounded-full ${
                      evt.source === "db" ? "bg-primary-500" : "bg-slate-400"
                    } ${isConflict(evt.id) ? "ring-1 ring-rose-400" : ""}`}
                  />
                ))}
                {bucket.length > 3 ? (
                  <span className="text-[10px] text-slate-500">+{bucket.length - 3}</span>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-1">
              {bucket.length === 0 ? (
                <p className="text-[11px] text-slate-400">-</p>
              ) : (
                <div className="hidden space-y-1 sm:block">
                  {bucket
                    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                    .map((evt) => (
                      <button
                        key={evt.id}
                        className={`block w-full max-w-full overflow-hidden rounded border px-1 py-0.5 text-left text-[11px] ${
                          evt.source === "db"
                            ? "border-primary-200 bg-primary-50/70"
                            : "border-slate-200 bg-slate-100"
                        } ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                        onClick={() => onSelectEvent?.(evt.id)}
                        type="button"
                      >
                        <div className="flex items-center gap-1">
                          <span className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                            {formatTime(evt.start)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-slate-700">{evt.title}</span>
                          {evt.status ? (
                            <span className="rounded bg-white px-1 text-[10px] uppercase text-primary-700">
                              {evt.status}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                </div>
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
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const dayPeriodRaw = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const dayPeriod = dayPeriodRaw ? dayPeriodRaw.toLowerCase().slice(0, 1) : "";
  const minutePart = minute && minute !== "00" ? `:${minute}` : "";
  return `${hour}${minutePart}${dayPeriod}`;
}
