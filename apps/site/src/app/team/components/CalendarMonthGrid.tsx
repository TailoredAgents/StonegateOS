import React from "react";
import { formatDayKey, TEAM_TIME_ZONE } from "../lib/timezone";
import { formatCalendarEventAmounts, formatCompactUsdCents } from "./calendarEventAmounts";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  appointmentType?: string | null;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  projectedRevenueByDay: Record<string, number>;
  onSelectEvent?: (id: string) => void;
  anchorDay: string;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarMonthGrid({
  events,
  conflicts,
  projectedRevenueByDay,
  onSelectEvent,
  anchorDay,
  selectedDay,
  onSelectDay
}: Props): React.ReactElement {
  const anchor = parseDayKey(anchorDay) ?? new Date();
  const firstOfMonth = getMonthStart(anchor);
  const monthStartWeekday = getWeekdayIndex(firstOfMonth);
  const startDate = new Date(firstOfMonth.getTime() - monthStartWeekday * DAY_MS);
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
  const isInPersonQuote = (evt: CalendarEvent): boolean =>
    evt.source === "db" && (evt.appointmentType ?? "").trim().toLowerCase() === "in_person_quote";

  return (
    <div className="grid grid-cols-7 gap-2 text-sm">
      {cells.map((day, idx) => {
        const key = formatDayKey(day);
        const inMonth = getMonthStart(day).getTime() === firstOfMonth.getTime();
        const bucket = buckets.get(key) ?? [];
        const projectedRevenue = projectedRevenueByDay[key] ?? 0;
        const projectedRevenueLabel = projectedRevenue > 0 ? formatCompactUsdCents(projectedRevenue) : null;
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
              title={projectedRevenueLabel ? `Projected revenue ${projectedRevenueLabel}` : undefined}
              className={`mb-1 w-full text-left text-[11px] font-semibold uppercase ${
                isSelected ? "text-primary-700" : "text-slate-500"
              }`}
            >
              <span className="block">
                {day.toLocaleDateString(undefined, {
                  timeZone: TEAM_TIME_ZONE,
                  weekday: "short",
                  day: "numeric"
                })}
              </span>
              {projectedRevenueLabel ? (
                <span className="block truncate text-[10px] font-semibold normal-case text-emerald-700">
                  Proj {projectedRevenueLabel}
                </span>
              ) : null}
            </button>

            {bucket.length ? (
              <div className="flex flex-wrap items-center gap-1 sm:hidden" aria-label={`${bucket.length} events`}>
                {bucket.slice(0, 3).map((evt) => (
                  <span
                    key={evt.id}
                    className={`h-1.5 w-1.5 rounded-full ${
                      evt.source === "db" ? (isInPersonQuote(evt) ? "bg-fuchsia-500" : "bg-primary-500") : "bg-slate-400"
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
                    .map((evt) => {
                      const amountSummary = evt.source === "db" ? formatCalendarEventAmounts(evt) : null;
                      return (
                        <button
                          key={evt.id}
                          className={`block w-full max-w-full overflow-hidden rounded border px-1 py-0.5 text-left text-[11px] ${
                            evt.source === "db"
                              ? isInPersonQuote(evt)
                                ? "border-fuchsia-200 bg-fuchsia-50/70"
                                : "border-primary-200 bg-primary-50/70"
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
                            {isInPersonQuote(evt) ? (
                              <span className="rounded bg-white px-1 text-[10px] uppercase text-fuchsia-700">quote</span>
                            ) : null}
                            {evt.status ? (
                              <span className={`rounded bg-white px-1 text-[10px] uppercase ${isInPersonQuote(evt) ? "text-fuchsia-700" : "text-primary-700"}`}>
                                {evt.status}
                              </span>
                            ) : null}
                          </div>
                          {amountSummary ? <div className="truncate text-[10px] text-slate-600">{amountSummary}</div> : null}
                        </button>
                      );
                    })}
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

function getMonthStart(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TIME_ZONE, year: "numeric", month: "2-digit" }).formatToParts(
    date
  );
  const year = Number(parts.find((p) => p.type === "year")?.value ?? "");
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "");
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12, 0, 0, 0));
  }
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0, 0));
}
