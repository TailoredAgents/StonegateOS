"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarGrid, type CalendarEvent } from "./CalendarGrid";
import { CalendarMonthGrid } from "./CalendarMonthGrid";
import { CalendarEventDetail } from "./CalendarEventDetail";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDayKeyForLabel,
  formatCalendarDayKey,
  getCalendarWeekStart,
  TEAM_TIME_ZONE,
  type CalendarView,
} from "../lib/calendar-time";
import { teamSurfaceHref } from "../surface-registry";
import { TEAM_CARD } from "./team-ui";
import {
  buildRevenueSummaryByDay,
  formatCalendarEventAmounts,
  formatUsdCents,
} from "./calendarEventAmounts";
import {
  getCalendarEventBadgeClass,
  getCalendarEventSelectedRingClass,
  getCalendarEventSurfaceClass,
} from "./calendarEventTone";
import {
  countActiveCalendarFilters,
  filterCalendarEvents,
  parseCalendarFilters,
} from "../lib/calendar-filters";

type Props = {
  initialView: CalendarView;
  initialAnchor: string;
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  teamMembers: Array<{ id: string; name: string }>;
  canUpdateAppointments: boolean;
  canCollectPayments: boolean;
  canSendCustomerMessages: boolean;
  canManageAppointmentMedia: boolean;
  canOverrideScheduleConflicts: boolean;
  googleCalendarState: "disabled" | "loaded" | "unavailable";
};

export function CalendarViewer({
  initialView,
  initialAnchor,
  events,
  conflicts,
  teamMembers,
  canUpdateAppointments,
  canCollectPayments,
  canSendCustomerMessages,
  canManageAppointmentMedia,
  canOverrideScheduleConflicts,
  googleCalendarState,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams?.get("calView");
  const requestedEventId = searchParams?.get("eventId") ?? null;
  const filters = React.useMemo(
    () =>
      parseCalendarFilters({
        status: searchParams?.get("calStatus"),
        crew: searchParams?.get("calCrew"),
        source: searchParams?.get("calSource"),
        conflict: searchParams?.get("calConflict"),
      }),
    [searchParams],
  );
  const conflictIds = React.useMemo(
    () => new Set(conflicts.flatMap((pair) => [pair.a, pair.b])),
    [conflicts],
  );
  const filteredEvents = React.useMemo(
    () => filterCalendarEvents(events, conflictIds, filters),
    [conflictIds, events, filters],
  );
  const activeFilterCount = countActiveCalendarFilters(filters);

  const [view, setView] = React.useState<CalendarView>(initialView);
  const [selectedId, setSelectedId] = React.useState<string | null>(() =>
    requestedEventId &&
    filteredEvents.some((event) => event.id === requestedEventId)
      ? requestedEventId
      : null,
  );
  const [anchorDay, setAnchorDay] = React.useState<string>(() =>
    initialAnchor?.trim()?.length
      ? initialAnchor
      : formatCalendarDayKey(new Date()),
  );
  const [selectedDay, setSelectedDay] = React.useState<string>(() =>
    initialAnchor?.trim()?.length
      ? initialAnchor
      : formatCalendarDayKey(new Date()),
  );
  const [isMobileViewport, setIsMobileViewport] = React.useState(false);
  const detailRef = React.useRef<HTMLElement | null>(null);
  const lastTriggerRef = React.useRef<HTMLElement | null>(null);
  const selectedEvent = selectedId
    ? (filteredEvents.find((evt) => evt.id === selectedId) ?? null)
    : null;

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

  React.useEffect(() => {
    setSelectedId(
      requestedEventId &&
        filteredEvents.some((event) => event.id === requestedEventId)
        ? requestedEventId
        : null,
    );
  }, [filteredEvents, requestedEventId]);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 639px)");
    const syncViewport = (event?: MediaQueryList | MediaQueryListEvent) => {
      setIsMobileViewport(event?.matches ?? media.matches);
    };
    syncViewport(media);
    const listener = (event: MediaQueryListEvent) => syncViewport(event);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  React.useEffect(() => {
    if (!isMobileViewport || requestedView) return;
    setView("day");
  }, [isMobileViewport, requestedView]);

  React.useEffect(() => {
    if (!selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      detailRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  const dayEvents = React.useMemo(() => {
    return filteredEvents
      .filter((evt) => dayKeyFromIso(evt.start) === selectedDay)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [filteredEvents, selectedDay]);
  const revenueSummaryByDay = React.useMemo(
    () => buildRevenueSummaryByDay(filteredEvents),
    [filteredEvents],
  );
  const selectedDayRevenueSummary = revenueSummaryByDay[selectedDay] ?? null;
  const selectedDayRevenueLabel = selectedDayRevenueSummary
    ? formatUsdCents(selectedDayRevenueSummary.amountCents)
    : null;
  const selectedConflicts = React.useMemo(() => {
    if (!selectedId) return [];
    const otherIds = conflicts.flatMap((pair) => {
      if (pair.a === selectedId) return [pair.b];
      if (pair.b === selectedId) return [pair.a];
      return [];
    });
    return Array.from(new Set(otherIds))
      .map((id) => events.find((event) => event.id === id) ?? null)
      .filter((event): event is CalendarEvent => event !== null);
  }, [conflicts, events, selectedId]);

  const updateCalendarUrl = React.useCallback(
    (next: {
      anchorDay?: string;
      view?: CalendarView;
      selectedEventId?: string | null;
    }) => {
      const params = new URLSearchParams(searchParams?.toString());
      params.delete("tab");
      params.delete("_canonical");
      const nextAnchor = (next.anchorDay ?? anchorDay).trim();
      if (nextAnchor) {
        params.set("cal", nextAnchor);
      } else {
        params.delete("cal");
      }

      const nextView = next.view ?? view;
      params.set("calView", nextView);
      if (next.selectedEventId === null) {
        params.delete("eventId");
      } else if (typeof next.selectedEventId === "string") {
        params.set("eventId", next.selectedEventId);
      }
      router.push(teamSurfaceHref("calendar", { query: params }));
    },
    [anchorDay, router, searchParams, view],
  );

  const updateCalendarFilter = React.useCallback(
    (
      name: "calStatus" | "calCrew" | "calSource" | "calConflict",
      value: string,
    ) => {
      const params = new URLSearchParams(searchParams?.toString());
      params.delete("tab");
      params.delete("_canonical");
      params.delete("eventId");
      params.set("cal", anchorDay);
      params.set("calView", view);
      if (value) params.set(name, value);
      else params.delete(name);
      setSelectedId(null);
      router.push(teamSurfaceHref("calendar", { query: params }));
    },
    [anchorDay, router, searchParams, view],
  );

  const resetCalendarFilters = React.useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString());
    for (const name of [
      "calStatus",
      "calCrew",
      "calSource",
      "calConflict",
      "eventId",
    ]) {
      params.delete(name);
    }
    params.delete("tab");
    params.delete("_canonical");
    params.set("cal", anchorDay);
    params.set("calView", view);
    setSelectedId(null);
    router.push(teamSurfaceHref("calendar", { query: params }));
  }, [anchorDay, router, searchParams, view]);

  const statusOptions = React.useMemo(
    () =>
      Array.from(
        new Set(
          events
            .map((event) => event.status?.trim().toLowerCase() ?? "")
            .filter(Boolean),
        ),
      ).sort(),
    [events],
  );
  const crewFilterOptions = React.useMemo(() => {
    const options = new Map(
      teamMembers.map((member) => [member.id, member.name]),
    );
    for (const event of events) {
      for (const [index, memberId] of (event.crewMemberIds ?? []).entries()) {
        if (!options.has(memberId)) {
          options.set(
            memberId,
            event.crewNames?.[index] ?? "Inactive crew member",
          );
        }
      }
    }
    return Array.from(options, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [events, teamMembers]);

  const handleSelectEvent = React.useCallback(
    (id: string) => {
      if (document.activeElement instanceof HTMLElement) {
        lastTriggerRef.current = document.activeElement;
      }
      setSelectedId(id);
      const evt = filteredEvents.find((e) => e.id === id);
      if (evt) {
        const key = dayKeyFromIso(evt.start);
        if (key) {
          setSelectedDay(key);
          setAnchorDay(key);
          updateCalendarUrl({ anchorDay: key, selectedEventId: id });
        }
      }
    },
    [filteredEvents, updateCalendarUrl],
  );

  const closeEventDetail = React.useCallback(() => {
    setSelectedId(null);
    updateCalendarUrl({ selectedEventId: null });
    window.requestAnimationFrame(() => lastTriggerRef.current?.focus());
  }, [updateCalendarUrl]);

  const handleSelectDay = React.useCallback(
    (day: string) => {
      setSelectedDay(day);
      setAnchorDay(day);
      const next = filteredEvents
        .filter((evt) => dayKeyFromIso(evt.start) === day)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      setSelectedId(next?.id ?? null);
      updateCalendarUrl({
        anchorDay: day,
        selectedEventId: next?.id ?? null,
      });
    },
    [filteredEvents, updateCalendarUrl],
  );

  const handlePrev = React.useCallback(() => {
    const nextAnchor =
      view === "month"
        ? addCalendarMonths(anchorDay, -1)
        : view === "day"
          ? addCalendarDays(anchorDay, -1)
          : addCalendarDays(anchorDay, -7);
    setAnchorDay(nextAnchor);
    setSelectedDay(nextAnchor);
    setSelectedId(null);
    updateCalendarUrl({ anchorDay: nextAnchor, selectedEventId: null });
  }, [anchorDay, updateCalendarUrl, view]);

  const handleNext = React.useCallback(() => {
    const nextAnchor =
      view === "month"
        ? addCalendarMonths(anchorDay, 1)
        : view === "day"
          ? addCalendarDays(anchorDay, 1)
          : addCalendarDays(anchorDay, 7);
    setAnchorDay(nextAnchor);
    setSelectedDay(nextAnchor);
    setSelectedId(null);
    updateCalendarUrl({ anchorDay: nextAnchor, selectedEventId: null });
  }, [anchorDay, updateCalendarUrl, view]);

  const title = React.useMemo(() => {
    if (view === "month") {
      return formatMonthLabel(anchorDay);
    }
    const weekStart = getCalendarWeekStart(anchorDay);
    if (view === "day") {
      return formatDayKeyLabel(anchorDay);
    }
    return `Week of ${formatShortDateLabel(weekStart)} · ${formatMonthLabel(weekStart)}`;
  }, [anchorDay, view]);

  return (
    <div className="space-y-4">
      <div
        className={`${TEAM_CARD} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const today = formatCalendarDayKey(new Date());
              setAnchorDay(today);
              setSelectedDay(today);
              setSelectedId(null);
              updateCalendarUrl({ anchorDay: today, selectedEventId: null });
            }}
            className="inline-flex min-h-11 items-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
          >
            Today
          </button>
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Previous calendar period"
            className="inline-flex min-h-11 items-center rounded-full bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-300"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={handleNext}
            aria-label="Next calendar period"
            className="inline-flex min-h-11 items-center rounded-full bg-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-300"
          >
            Next
          </button>
          <div className="w-full pt-1 text-base font-semibold text-slate-900 sm:w-auto sm:pt-0">
            {title}
          </div>
        </div>

        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Calendar view"
        >
          <div className="hidden items-center gap-2 pr-2 text-[11px] font-semibold text-slate-600 sm:flex">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Confirmed
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-sky-500" />
              Quotes
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              Canceled
            </span>
          </div>
          <button
            type="button"
            aria-pressed={view === "day"}
            onClick={() => {
              setView("day");
              updateCalendarUrl({ view: "day" });
            }}
            className={`min-h-11 rounded-full px-4 py-2 text-xs font-semibold ${
              view === "day"
                ? "bg-primary-600 text-white"
                : "bg-slate-200 text-slate-700 hover:bg-slate-300"
            }`}
          >
            Day
          </button>
          <button
            type="button"
            aria-pressed={view === "week"}
            onClick={() => {
              setView("week");
              updateCalendarUrl({ view: "week" });
            }}
            className={`min-h-11 rounded-full px-4 py-2 text-xs font-semibold ${
              view === "week"
                ? "bg-primary-600 text-white"
                : "bg-slate-200 text-slate-700 hover:bg-slate-300"
            }`}
          >
            Week
          </button>
          <button
            type="button"
            aria-pressed={view === "month"}
            onClick={() => {
              setView("month");
              updateCalendarUrl({ view: "month" });
            }}
            className={`min-h-11 rounded-full px-4 py-2 text-xs font-semibold ${
              view === "month"
                ? "bg-primary-600 text-white"
                : "bg-slate-200 text-slate-700 hover:bg-slate-300"
            }`}
          >
            Month
          </button>
        </div>
      </div>

      <div className={`${TEAM_CARD} p-3`}>
        <div className="mb-2 flex min-h-11 flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Calendar filters
            </h2>
            <p className="text-xs text-slate-600" aria-live="polite">
              {activeFilterCount > 0
                ? `${activeFilterCount} active ${activeFilterCount === 1 ? "filter" : "filters"} - showing ${filteredEvents.length} of ${events.length} items.`
                : `Showing all ${events.length} calendar items.`}
            </p>
          </div>
          <button
            type="button"
            onClick={resetCalendarFilters}
            disabled={activeFilterCount === 0}
            className="inline-flex min-h-11 items-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-primary-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset filters
            {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            <span>Status</span>
            <select
              value={filters.status ?? ""}
              onChange={(event) =>
                updateCalendarFilter("calStatus", event.target.value)
              }
              className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="">All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {formatFilterLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            <span>Crew member</span>
            <select
              value={filters.crewMemberId ?? ""}
              onChange={(event) =>
                updateCalendarFilter("calCrew", event.target.value)
              }
              className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="">All crew</option>
              {crewFilterOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            <span>Source</span>
            <select
              value={filters.source ?? ""}
              onChange={(event) =>
                updateCalendarFilter("calSource", event.target.value)
              }
              className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="">CRM and Google</option>
              <option value="db">CRM appointments</option>
              <option value="google">Google events</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            <span>Scheduling</span>
            <select
              value={filters.conflictsOnly ? "only" : ""}
              onChange={(event) =>
                updateCalendarFilter("calConflict", event.target.value)
              }
              className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="">All items</option>
              <option value="only">Conflicts only</option>
            </select>
          </label>
        </div>
      </div>

      {googleCalendarState === "unavailable" ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <div className="font-semibold">Google Calendar is unavailable</div>
          <p className="mt-1">
            CRM appointments are still shown, but independent Google events may
            be missing. Do not treat an apparently open time as confirmed until
            Calendar Sync recovers.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          {filteredEvents.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white/90 p-6 text-center shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">
                {events.length === 0
                  ? "No calendar items in this period"
                  : "No calendar items match these filters"}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {events.length === 0
                  ? "CRM appointments and Google events will appear here when scheduled."
                  : "Change or reset the active filters to see the hidden items."}
              </p>
              {events.length > 0 ? (
                <button
                  type="button"
                  onClick={resetCalendarFilters}
                  className="mt-4 inline-flex min-h-11 items-center rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
                >
                  Clear all filters
                </button>
              ) : null}
            </div>
          ) : view === "month" ? (
            <CalendarMonthGrid
              events={filteredEvents}
              conflicts={conflicts}
              revenueSummaryByDay={revenueSummaryByDay}
              anchorDay={anchorDay}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
              onSelectEvent={handleSelectEvent}
            />
          ) : view === "day" ? (
            <div className="rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase text-slate-500">
                  {formatDayKeyLabel(selectedDay)}
                </div>
                {selectedDayRevenueSummary && selectedDayRevenueLabel ? (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold uppercase text-emerald-700">
                    {selectedDayRevenueSummary.label} {selectedDayRevenueLabel}
                  </span>
                ) : null}
              </div>
              {dayEvents.length === 0 ? (
                <p className="text-sm text-slate-500">
                  {activeFilterCount > 0
                    ? "No items on this day match the active filters."
                    : "No CRM appointments or Google events on this day."}
                </p>
              ) : (
                <div className="space-y-2">
                  {dayEvents.map((evt) => {
                    const amountSummary =
                      evt.source === "db"
                        ? formatCalendarEventAmounts(evt)
                        : null;
                    return (
                      <button
                        key={evt.id}
                        type="button"
                        onClick={() => handleSelectEvent(evt.id)}
                        aria-pressed={evt.id === selectedId}
                        aria-label={`${formatTimeRange(evt.start, evt.end)}, ${evt.title}${evt.status ? `, ${evt.status.replace(/_/gu, " ")}` : ""}`}
                        className={`block w-full overflow-hidden rounded-lg border px-3 py-3 text-left ${getCalendarEventSurfaceClass(evt)} ${
                          evt.id === selectedId
                            ? getCalendarEventSelectedRingClass(evt)
                            : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-slate-800">
                            {formatTimeRange(evt.start, evt.end)}
                          </span>
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-600">
                              {evt.source === "db" ? "CRM" : "Google"}
                            </span>
                            {evt.source === "db" &&
                            (evt.appointmentType ?? "").trim().toLowerCase() ===
                              "in_person_quote" ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
                                quote
                              </span>
                            ) : null}
                            {evt.status ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${getCalendarEventBadgeClass(evt)}`}
                              >
                                {evt.status}
                              </span>
                            ) : null}
                            {conflictIds.has(evt.id) ? (
                              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-rose-800">
                                Conflict
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="mt-1 truncate text-sm font-semibold text-slate-900">
                          {evt.title}
                        </div>
                        {amountSummary ? (
                          <div className="truncate text-xs text-slate-600">
                            {amountSummary}
                          </div>
                        ) : null}
                        {evt.address ? (
                          <div className="truncate text-xs text-slate-600">
                            {evt.address}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <CalendarGrid
              events={filteredEvents}
              conflicts={conflicts}
              revenueSummaryByDay={revenueSummaryByDay}
              anchorDay={anchorDay}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
              onSelectEvent={handleSelectEvent}
            />
          )}
        </div>

        <aside
          ref={detailRef}
          tabIndex={-1}
          aria-label="Selected calendar day and event details"
          onKeyDown={(event) => {
            if (event.key === "Escape" && selectedEvent) closeEventDetail();
          }}
          className="min-w-0 focus:outline-none"
        >
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase text-slate-500">
                  Details
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {formatDayKeyLabel(selectedDay)}
                </div>
                {selectedDayRevenueSummary && selectedDayRevenueLabel ? (
                  <div className="mt-1 text-[11px] font-semibold text-emerald-700">
                    {selectedDayRevenueSummary.label} {selectedDayRevenueLabel}
                  </div>
                ) : null}
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                {dayEvents.length} {dayEvents.length === 1 ? "item" : "items"}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {dayEvents.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Select a date to see appointments.
                </p>
              ) : (
                dayEvents.slice(0, 8).map((evt) => {
                  const amountSummary =
                    evt.source === "db"
                      ? formatCalendarEventAmounts(evt)
                      : null;
                  return (
                    <button
                      key={evt.id}
                      type="button"
                      onClick={() => handleSelectEvent(evt.id)}
                      aria-pressed={evt.id === selectedId}
                      aria-label={`${formatTimeRange(evt.start, evt.end)}, ${evt.title}${evt.status ? `, ${evt.status.replace(/_/gu, " ")}` : ""}`}
                      className={`block w-full overflow-hidden rounded-xl border px-3 py-2 text-left text-sm ${getCalendarEventSurfaceClass(evt)} ${
                        evt.id === selectedId
                          ? getCalendarEventSelectedRingClass(evt)
                          : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="whitespace-nowrap text-[11px] font-semibold tabular-nums text-slate-700">
                          {formatTimeRange(evt.start, evt.end)}
                        </span>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                            {evt.source === "db" ? "CRM" : "Google"}
                          </span>
                          {evt.source === "db" &&
                          (evt.appointmentType ?? "").trim().toLowerCase() ===
                            "in_person_quote" ? (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${getCalendarEventBadgeClass(evt)}`}
                            >
                              quote
                            </span>
                          ) : null}
                          {evt.status ? (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${getCalendarEventBadgeClass(evt)}`}
                            >
                              {evt.status}
                            </span>
                          ) : null}
                          {conflictIds.has(evt.id) ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-800">
                              Conflict
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1 truncate font-semibold text-slate-900">
                        {evt.title}
                      </div>
                      {amountSummary ? (
                        <div className="truncate text-[11px] text-slate-600">
                          {amountSummary}
                        </div>
                      ) : null}
                      {evt.address ? (
                        <div className="truncate text-[11px] text-slate-600">
                          {evt.address}
                        </div>
                      ) : null}
                    </button>
                  );
                })
              )}
              {dayEvents.length > 8 ? (
                <div className="text-xs text-slate-500">
                  +{dayEvents.length - 8} more… use day view to see all.
                </div>
              ) : null}
            </div>

            <div className="mt-4">
              {selectedEvent ? (
                <CalendarEventDetail
                  event={selectedEvent}
                  teamMembers={teamMembers}
                  conflictingEvents={selectedConflicts}
                  canUpdateAppointments={canUpdateAppointments}
                  canCollectPayments={canCollectPayments}
                  canSendCustomerMessages={canSendCustomerMessages}
                  canManageAppointmentMedia={canManageAppointmentMedia}
                  canOverrideScheduleConflicts={canOverrideScheduleConflicts}
                  onClose={closeEventDetail}
                  variant="embedded"
                />
              ) : (
                <p className="text-sm text-slate-500">
                  Select an appointment to see full details.
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function dayKeyFromIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const key = formatCalendarDayKey(d);
  return key.length > 0 ? key : null;
}

function formatDayKeyLabel(dayKey: string): string {
  const date = calendarDayKeyForLabel(dayKey);
  if (!date) return dayKey;
  return date.toLocaleDateString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
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

function formatMonthLabel(dayKey: string): string {
  const date = calendarDayKeyForLabel(dayKey) ?? new Date();
  return date.toLocaleDateString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    month: "long",
    year: "numeric",
  });
}

function formatFilterLabel(value: string): string {
  return value
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatShortDateLabel(dayKey: string): string {
  const date = calendarDayKeyForLabel(dayKey) ?? new Date();
  return date.toLocaleDateString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
