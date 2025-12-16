"use client";

import React from "react";
import { CalendarGrid, type CalendarEvent } from "./CalendarGrid";
import { CalendarMonthGrid } from "./CalendarMonthGrid";
import { CalendarEventDetail } from "./CalendarEventDetail";

type Props = {
  initialView: "week" | "month";
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
};

export function CalendarViewer({ initialView, events, conflicts }: Props) {
  const [view, setView] = React.useState<"week" | "month">(initialView);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectedDay, setSelectedDay] = React.useState<string>(() => new Date().toISOString().slice(0, 10));
  const selectedEvent = selectedId ? events.find((evt) => evt.id === selectedId) ?? null : null;

  const dayEvents = React.useMemo(() => {
    if (view !== "month") return [];
    return events
      .filter((evt) => dayKeyFromIso(evt.start) === selectedDay)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [events, selectedDay, view]);

  const handleSelectEvent = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      const evt = events.find((e) => e.id === id);
      if (evt) {
        const key = dayKeyFromIso(evt.start);
        if (key) setSelectedDay(key);
      }
    },
    [events]
  );

  const handleSelectDay = React.useCallback(
    (day: string) => {
      setSelectedDay(day);
      const next = events
        .filter((evt) => dayKeyFromIso(evt.start) === day)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      setSelectedId(next?.id ?? null);
    },
    [events]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setView("week")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "week" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Week view
        </button>
        <button
          type="button"
          onClick={() => setView("month")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "month" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Month view
        </button>
      </div>

      {view === "month" ? (
        <div className="space-y-3">
          <CalendarMonthGrid
            events={events}
            conflicts={conflicts}
            selectedDay={selectedDay}
            onSelectDay={handleSelectDay}
            onSelectEvent={handleSelectEvent}
          />
          <div className="sm:hidden rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm">
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
        <CalendarGrid events={events} conflicts={conflicts} onSelectEvent={handleSelectEvent} />
      )}

      {selectedEvent ? <CalendarEventDetail event={selectedEvent} /> : null}
    </div>
  );
}

function dayKeyFromIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function formatDayKeyLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
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
  return `${formatTime(startIso)}–${formatTime(endIso)}`;
}
