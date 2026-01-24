"use client";

import React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarGrid, type CalendarEvent } from "./CalendarGrid";
import { CalendarMonthGrid } from "./CalendarMonthGrid";
import { CalendarEventDetail } from "./CalendarEventDetail";
import { formatDayKey, TEAM_TIME_ZONE } from "../lib/timezone";

type Props = {
  initialView: "week" | "month";
  initialAnchor: string;
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
};

export function CalendarViewer({ initialView, initialAnchor, events, conflicts }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [view, setView] = React.useState<"week" | "month">(initialView);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [anchorDay, setAnchorDay] = React.useState<string>(() => (initialAnchor?.trim()?.length ? initialAnchor : formatDayKey(new Date())));
  const [selectedDay, setSelectedDay] = React.useState<string>(() => (initialAnchor?.trim()?.length ? initialAnchor : formatDayKey(new Date())));
  const selectedEvent = selectedId ? events.find((evt) => evt.id === selectedId) ?? null : null;

  React.useEffect(() => {
    setView(initialView);
  }, [initialView]);

  React.useEffect(() => {
    const next = initialAnchor?.trim();
    if (next) {
      setAnchorDay(next);
      setSelectedDay(next);
    }
  }, [initialAnchor]);

  const dayEvents = React.useMemo(() => {
    if (view !== "month") return [];
    return events
      .filter((evt) => dayKeyFromIso(evt.start) === selectedDay)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [events, selectedDay, view]);

  const updateCalendarUrl = React.useCallback(
    (next: { anchorDay?: string; view?: "week" | "month" }) => {
      const params = new URLSearchParams(searchParams?.toString());
      params.set("tab", "calendar");
      const nextAnchor = (next.anchorDay ?? anchorDay).trim();
      if (nextAnchor) {
        params.set("cal", nextAnchor);
      } else {
        params.delete("cal");
      }

      const nextView = next.view ?? view;
      params.set("calView", nextView);
      router.push(`${pathname}?${params.toString()}` as any);
    },
    [anchorDay, pathname, router, searchParams, view]
  );

  const handleSelectEvent = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      const evt = events.find((e) => e.id === id);
      if (evt) {
        const key = dayKeyFromIso(evt.start);
        if (key) {
          setSelectedDay(key);
          setAnchorDay(key);
        }
      }
    },
    [events]
  );

  const handleSelectDay = React.useCallback(
    (day: string) => {
      setSelectedDay(day);
      setAnchorDay(day);
      const next = events
        .filter((evt) => dayKeyFromIso(evt.start) === day)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      setSelectedId(next?.id ?? null);
    },
    [events]
  );

  const handlePrev = React.useCallback(() => {
    const nextAnchor =
      view === "month" ? addMonthsToDayKey(anchorDay, -1) : addDaysToDayKey(anchorDay, -7);
    setAnchorDay(nextAnchor);
    setSelectedDay(nextAnchor);
    setSelectedId(null);
    updateCalendarUrl({ anchorDay: nextAnchor });
  }, [anchorDay, updateCalendarUrl, view]);

  const handleNext = React.useCallback(() => {
    const nextAnchor =
      view === "month" ? addMonthsToDayKey(anchorDay, 1) : addDaysToDayKey(anchorDay, 7);
    setAnchorDay(nextAnchor);
    setSelectedDay(nextAnchor);
    setSelectedId(null);
    updateCalendarUrl({ anchorDay: nextAnchor });
  }, [anchorDay, updateCalendarUrl, view]);

  const title = React.useMemo(() => {
    if (view === "month") {
      return formatMonthLabel(anchorDay);
    }
    const weekStart = getWeekStartDayKey(anchorDay);
    return `Week of ${formatShortDateLabel(weekStart)}`;
  }, [anchorDay, view]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-300"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-300"
          >
            Next
          </button>
          <div className="ml-1 text-sm font-semibold text-slate-900">{title}</div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => {
              setView("week");
              updateCalendarUrl({ view: "week" });
            }}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              view === "week" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700 hover:bg-slate-300"
            }`}
          >
            Week view
          </button>
          <button
            type="button"
            onClick={() => {
              setView("month");
              updateCalendarUrl({ view: "month" });
            }}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              view === "month" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700 hover:bg-slate-300"
            }`}
          >
            Month view
          </button>
        </div>
      </div>

      {view === "month" ? (
        <div className="space-y-3">
          <CalendarMonthGrid
            events={events}
            conflicts={conflicts}
            anchorDay={anchorDay}
            selectedDay={selectedDay}
            onSelectDay={handleSelectDay}
            onSelectEvent={handleSelectEvent}
          />
          <div className="rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm sm:hidden">
            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
              {formatDayKeyLabel(selectedDay)}
            </div>
            {dayEvents.length === 0 ? (
              <p className="text-xs text-slate-500">No appointments.</p>
            ) : (
              <div className="space-y-2">
                {dayEvents.map((evt) => (
                  <button
                    key={evt.id}
                    type="button"
                    onClick={() => handleSelectEvent(evt.id)}
                    className={`block w-full overflow-hidden rounded-lg border px-2 py-2 text-left ${
                      evt.source === "db" ? "border-primary-200 bg-primary-50/70" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="whitespace-nowrap text-[11px] font-semibold tabular-nums text-slate-800">
                      {formatTimeRange(evt.start, evt.end)}
                    </div>
                    <div className="mt-0.5 truncate text-sm font-semibold text-slate-900">{evt.title}</div>
                    {evt.address ? <div className="truncate text-xs text-slate-600">{evt.address}</div> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <CalendarGrid events={events} conflicts={conflicts} anchorDay={anchorDay} onSelectEvent={handleSelectEvent} />
      )}

      {selectedEvent ? <CalendarEventDetail event={selectedEvent} /> : null}
    </div>
  );
}

function dayKeyFromIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const key = formatDayKey(d);
  return key.length > 0 ? key : null;
}

function formatDayKeyLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return dayKey;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return dayKey;
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return dayKey;
  return date.toLocaleDateString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric"
  });
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

function addDaysToDayKey(dayKey: string, deltaDays: number): string {
  const base = parseDayKey(dayKey) ?? new Date();
  const next = new Date(base.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  return formatDayKey(next);
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

function getWeekStartDayKey(anchorDay: string): string {
  const base = parseDayKey(anchorDay) ?? new Date();
  const weekday = getWeekdayIndex(base);
  const start = new Date(base.getTime() - weekday * 24 * 60 * 60 * 1000);
  return formatDayKey(start);
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

function addMonthsToDayKey(dayKey: string, deltaMonths: number): string {
  const base = parseDayKey(dayKey) ?? new Date();
  const monthStart = getMonthStart(base);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const nextMonthStart = new Date(Date.UTC(year, month + deltaMonths, 1, 12, 0, 0, 0));
  return formatDayKey(nextMonthStart);
}

function formatMonthLabel(dayKey: string): string {
  const base = parseDayKey(dayKey) ?? new Date();
  const monthStart = getMonthStart(base);
  return monthStart.toLocaleDateString(undefined, { timeZone: TEAM_TIME_ZONE, month: "long", year: "numeric" });
}

function formatShortDateLabel(dayKey: string): string {
  const base = parseDayKey(dayKey) ?? new Date();
  return base.toLocaleDateString(undefined, { timeZone: TEAM_TIME_ZONE, month: "short", day: "numeric", year: "numeric" });
}
