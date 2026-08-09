import React from "react";
import {
  addCalendarDays,
  calendarDayKeyForLabel,
  formatCalendarDayKey,
  getCalendarWeekStart,
  TEAM_TIME_ZONE,
} from "../lib/calendar-time";
import {
  formatCalendarEventAmounts,
  formatUsdCents,
  type CalendarDayRevenueSummary,
} from "./calendarEventAmounts";
import {
  getCalendarEventBadgeClass,
  getCalendarEventSurfaceClass,
} from "./calendarEventTone";

export type CalendarEvent = {
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
  version?: string | null;
  notes?: Array<{ id: string; body: string; createdAt: string }>;
  crewMemberIds?: string[];
  crewNames?: string[];
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  revenueSummaryByDay: Record<string, CalendarDayRevenueSummary>;
  anchorDay: string;
  selectedDay?: string | null;
  onSelectDay?: (dayKey: string) => void;
  onSelectEvent?: (id: string) => void;
};

export function CalendarGrid({
  events,
  conflicts,
  revenueSummaryByDay,
  anchorDay,
  selectedDay,
  onSelectDay,
  onSelectEvent,
}: Props): React.ReactElement {
  const startOfWeek = getCalendarWeekStart(anchorDay);
  const days = Array.from({ length: 7 }).map((_, index) => {
    const key = addCalendarDays(startOfWeek, index);
    return { key, date: calendarDayKeyForLabel(key) ?? new Date() };
  });

  const dayBuckets: Record<string, CalendarEvent[]> = {};
  for (const day of days) {
    const key = day.key;
    if (key) {
      dayBuckets[key] = [];
    }
  }

  for (const evt of events) {
    const parsed = new Date(evt.start);
    const dayKey = Number.isNaN(parsed.getTime())
      ? ""
      : formatCalendarDayKey(parsed);
    if (dayBuckets[dayKey]) {
      dayBuckets[dayKey].push(evt);
    }
  }

  const isConflict = (id: string) =>
    conflicts.some((c) => c.a === id || c.b === id);
  const isInPersonQuote = (evt: CalendarEvent): boolean =>
    evt.source === "db" &&
    (evt.appointmentType ?? "").trim().toLowerCase() === "in_person_quote";

  return (
    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-7">
      {days.map(({ key, date }) => {
        const bucket = dayBuckets[key] ?? [];
        const revenueSummary = revenueSummaryByDay[key] ?? null;
        const revenueLabel = revenueSummary
          ? formatUsdCents(revenueSummary.amountCents)
          : null;
        const isSelected =
          typeof selectedDay === "string" && selectedDay.length > 0
            ? selectedDay === key
            : false;
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
              title={
                revenueSummary && revenueLabel
                  ? `${revenueSummary.label} revenue ${revenueLabel}`
                  : undefined
              }
              className={`mb-2 min-h-11 w-full text-left text-xs font-semibold uppercase ${
                isSelected
                  ? "text-primary-700"
                  : "text-slate-500 hover:text-primary-700"
              }`}
            >
              <span className="block">
                {date.toLocaleDateString(undefined, {
                  timeZone: TEAM_TIME_ZONE,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {revenueSummary && revenueLabel ? (
                <span className="block whitespace-normal text-[11px] font-semibold normal-case leading-4 text-emerald-700">
                  {revenueSummary.label} {revenueLabel}
                </span>
              ) : null}
            </button>
            <div className="space-y-2">
              {bucket.length === 0 ? (
                <p className="text-xs text-slate-400">Empty</p>
              ) : (
                bucket
                  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                  .map((evt) => {
                    const amountSummary =
                      evt.source === "db"
                        ? formatCalendarEventAmounts(evt)
                        : null;
                    return (
                      <button
                        key={evt.id}
                        className={`block min-h-11 w-full max-w-full overflow-hidden rounded-lg border px-2 py-1 text-left ${getCalendarEventSurfaceClass(evt)} ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                        onClick={() => onSelectEvent?.(evt.id)}
                        type="button"
                        aria-label={`${formatTimeRange(evt.start, evt.end)}, ${evt.title}${isConflict(evt.id) ? ", scheduling conflict" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                            {formatTimeRange(evt.start, evt.end)}
                          </span>
                          <div className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-slate-600">
                            <span className="inline-flex rounded-full bg-white px-1.5 text-[10px] uppercase text-slate-500">
                              {evt.source === "db" ? "CRM" : "Google"}
                            </span>
                            {isInPersonQuote(evt) ? (
                              <span
                                className={`rounded-full px-1.5 text-[10px] uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
                                quote
                              </span>
                            ) : null}
                            {evt.status ? (
                              <span
                                className={`rounded-full px-1.5 text-[10px] uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
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
                        <div className="mt-0.5 truncate text-xs font-semibold text-slate-900">
                          {evt.title}
                        </div>
                        {amountSummary ? (
                          <div className="truncate text-[11px] text-slate-600">
                            {amountSummary}
                          </div>
                        ) : null}
                        {evt.address ? (
                          <div className="hidden truncate text-[11px] text-slate-500 md:block">
                            {evt.address}
                          </div>
                        ) : null}
                      </button>
                    );
                  })
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
    hour12: true,
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
