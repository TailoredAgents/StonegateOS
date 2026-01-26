import React from "react";
import { formatDayKey, TEAM_TIME_ZONE } from "../lib/timezone";

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
  notes?: Array<{ id: string; body: string; createdAt: string }>;
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  anchorDay: string;
  selectedDay?: string | null;
  onSelectDay?: (dayKey: string) => void;
  onSelectEvent?: (id: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarGrid({
  events,
  conflicts,
  anchorDay,
  selectedDay,
  onSelectDay,
  onSelectEvent
}: Props): React.ReactElement {
  const anchor = parseDayKey(anchorDay) ?? new Date();
  const weekday = getWeekdayIndex(anchor);
  const startOfWeek = new Date(anchor.getTime() - weekday * DAY_MS);

  const days = Array.from({ length: 7 }).map((_, i) => new Date(startOfWeek.getTime() + i * DAY_MS));

  const dayBuckets: Record<string, CalendarEvent[]> = {};
  for (const day of days) {
    const key = formatDayKey(day);
    if (key) {
      dayBuckets[key] = [];
    }
  }

  for (const evt of events) {
    const parsed = new Date(evt.start);
    const dayKey = Number.isNaN(parsed.getTime()) ? "" : formatDayKey(parsed);
    if (dayBuckets[dayKey]) {
      dayBuckets[dayKey].push(evt);
    }
  }

  const isConflict = (id: string) => conflicts.some((c) => c.a === id || c.b === id);

  return (
    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-7">
      {days.map((day) => {
        const key = formatDayKey(day);
        const bucket = dayBuckets[key] ?? [];
        const isSelected = typeof selectedDay === "string" && selectedDay.length > 0 ? selectedDay === key : false;
        return (
          <div
            key={key}
            className={`min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm ${
              isSelected ? "ring-2 ring-primary-200" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => onSelectDay?.(key)}
              className={`mb-2 w-full text-left text-xs font-semibold uppercase ${
                isSelected ? "text-primary-700" : "text-slate-500 hover:text-primary-700"
              }`}
            >
              {day.toLocaleDateString(undefined, {
                timeZone: TEAM_TIME_ZONE,
                weekday: "short",
                month: "short",
                day: "numeric"
              })}
            </button>
            <div className="space-y-2">
              {bucket.length === 0 ? (
                <p className="text-xs text-slate-400">Empty</p>
              ) : (
                bucket
                  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                  .map((evt) => (
                    <button
                      key={evt.id}
                      className={`block w-full max-w-full overflow-hidden rounded-lg border px-2 py-1 text-left ${
                        evt.source === "db" ? "border-primary-200 bg-primary-50/70" : "border-slate-200 bg-slate-50"
                      } ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                      onClick={() => onSelectEvent?.(evt.id)}
                      type="button"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                          {formatTimeRange(evt.start, evt.end)}
                        </span>
                        <div className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-slate-600">
                          <span className="hidden rounded-full bg-white px-1.5 text-[10px] uppercase text-slate-500 sm:inline-flex">
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
                      </div>
                      <div className="mt-0.5 truncate text-xs font-semibold text-slate-900">{evt.title}</div>
                      {evt.address ? (
                        <div className="hidden truncate text-[11px] text-slate-500 md:block">{evt.address}</div>
                      ) : null}
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

function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)} - ${formatTime(endIso)}`;
}

function parseDayKey(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function getWeekdayIndex(date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TIME_ZONE, weekday: "short" }).format(date);
  switch (weekday.toLowerCase().slice(0, 3)) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      return 0;
  }
}
