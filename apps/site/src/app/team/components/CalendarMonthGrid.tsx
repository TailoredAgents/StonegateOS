import React from "react";
import {
  addCalendarDays,
  calendarDayKeyForLabel,
  formatCalendarDayKey,
  getCalendarMonthGridStart,
  parseCalendarDayKey,
  TEAM_TIME_ZONE,
} from "../lib/calendar-time";
import {
  formatCalendarEventAmounts,
  formatUsdCents,
  type CalendarDayRevenueSummary,
} from "./calendarEventAmounts";
import {
  getCalendarEventBadgeClass,
  getCalendarEventDotClass,
  getCalendarEventSurfaceClass,
} from "./calendarEventTone";

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
  version?: string | null;
  crewMemberIds?: string[];
  crewNames?: string[];
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  revenueSummaryByDay: Record<string, CalendarDayRevenueSummary>;
  onSelectEvent?: (id: string) => void;
  anchorDay: string;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
};

export function CalendarMonthGrid({
  events,
  conflicts,
  revenueSummaryByDay,
  onSelectEvent,
  anchorDay,
  selectedDay,
  onSelectDay,
}: Props): React.ReactElement {
  const anchorParts = parseCalendarDayKey(anchorDay);
  const anchorMonth = anchorParts?.month ?? new Date().getUTCMonth() + 1;
  const gridStart = getCalendarMonthGridStart(anchorDay);
  const cells = Array.from({ length: 42 }).map((_, index) => {
    const key = addCalendarDays(gridStart, index);
    return { key, date: calendarDayKeyForLabel(key) ?? new Date() };
  });

  const buckets = new Map<string, CalendarEvent[]>();
  for (const cell of cells) {
    buckets.set(cell.key, []);
  }
  for (const evt of events) {
    const parsed = new Date(evt.start);
    const key = Number.isNaN(parsed.getTime())
      ? ""
      : formatCalendarDayKey(parsed);
    if (buckets.has(key)) {
      buckets.get(key)!.push(evt);
    }
  }

  const isConflict = (id: string) =>
    conflicts.some((c) => c.a === id || c.b === id);
  const isInPersonQuote = (evt: CalendarEvent): boolean =>
    evt.source === "db" &&
    (evt.appointmentType ?? "").trim().toLowerCase() === "in_person_quote";

  return (
    <div className="grid grid-cols-7 gap-2 text-sm">
      {cells.map(({ key, date }, idx) => {
        const inMonth = parseCalendarDayKey(key)?.month === anchorMonth;
        const bucket = buckets.get(key) ?? [];
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
            key={key + idx}
            className={`min-h-[120px] min-w-0 overflow-hidden rounded-xl border p-2 ${
              inMonth
                ? "border-slate-200 bg-white/90"
                : "border-slate-100 bg-slate-50"
            } ${isSelected ? "ring-2 ring-primary-200" : ""}`}
          >
            <button
              type="button"
              onClick={() => onSelectDay?.(key)}
              title={
                revenueSummary && revenueLabel
                  ? `${revenueSummary.label} revenue ${revenueLabel}`
                  : undefined
              }
              className={`mb-1 min-h-11 w-full text-left text-[11px] font-semibold uppercase ${
                isSelected ? "text-primary-700" : "text-slate-500"
              }`}
            >
              <span className="block">
                {date.toLocaleDateString(undefined, {
                  timeZone: TEAM_TIME_ZONE,
                  weekday: "short",
                  day: "numeric",
                })}
              </span>
              {revenueSummary && revenueLabel ? (
                <span className="block whitespace-normal text-[10px] font-semibold normal-case leading-4 text-emerald-700">
                  {revenueSummary.label} {revenueLabel}
                </span>
              ) : null}
            </button>

            {bucket.length ? (
              <div
                className="flex flex-wrap items-center gap-1 sm:hidden"
                aria-label={`${bucket.length} events`}
              >
                {bucket.slice(0, 3).map((evt) => (
                  <span
                    key={evt.id}
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${getCalendarEventDotClass(evt)} ${isConflict(evt.id) ? "ring-1 ring-rose-400" : ""}`}
                  />
                ))}
                {bucket.length > 3 ? (
                  <span className="text-[10px] text-slate-500">
                    +{bucket.length - 3}
                  </span>
                ) : null}
                <span className="sr-only">
                  {bucket
                    .map(
                      (event) =>
                        `${event.source === "db" ? "CRM appointment" : "Google event"}: ${event.title}${isConflict(event.id) ? ", scheduling conflict" : ""}`,
                    )
                    .join("; ")}
                </span>
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
                      const amountSummary =
                        evt.source === "db"
                          ? formatCalendarEventAmounts(evt)
                          : null;
                      return (
                        <button
                          key={evt.id}
                          className={`block w-full max-w-full overflow-hidden rounded border px-1 py-0.5 text-left text-[11px] ${getCalendarEventSurfaceClass(evt)} ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                          onClick={() => onSelectEvent?.(evt.id)}
                          type="button"
                          aria-label={`${formatTime(evt.start)}, ${evt.title}${isConflict(evt.id) ? ", scheduling conflict" : ""}`}
                        >
                          <div className="flex items-center gap-1">
                            <span className="whitespace-nowrap font-semibold tabular-nums text-slate-800">
                              {formatTime(evt.start)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-slate-700">
                              {evt.title}
                            </span>
                            <span className="rounded bg-white px-1 text-[10px] uppercase text-slate-500">
                              {evt.source === "db" ? "CRM" : "Google"}
                            </span>
                            {isInPersonQuote(evt) ? (
                              <span
                                className={`rounded px-1 text-[10px] uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
                                quote
                              </span>
                            ) : null}
                            {evt.status ? (
                              <span
                                className={`rounded px-1 text-[10px] uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
                                {evt.status}
                              </span>
                            ) : null}
                            {isConflict(evt.id) ? (
                              <span className="rounded bg-rose-100 px-1 text-[10px] uppercase text-rose-800">
                                Conflict
                              </span>
                            ) : null}
                          </div>
                          {amountSummary ? (
                            <div className="truncate text-[10px] text-slate-600">
                              {amountSummary}
                            </div>
                          ) : null}
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
    hour12: true,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const dayPeriodRaw = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const dayPeriod = dayPeriodRaw ? dayPeriodRaw.toLowerCase().slice(0, 1) : "";
  const minutePart = minute && minute !== "00" ? `:${minute}` : "";
  return `${hour}${minutePart}${dayPeriod}`;
}
