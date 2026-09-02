"use client";

import React from "react";
import type { CalendarEvent } from "./CalendarGrid";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { formatCalendarDayKey } from "../lib/calendar-time";
import { teamSurfaceHref } from "../surface-registry";
import { formatCalendarEventAmounts } from "./calendarEventAmounts";
import { CalendarAppointmentActions } from "./CalendarAppointmentActions";
import { getCalendarEventBadgeClass } from "./calendarEventTone";

type Props = {
  event: CalendarEvent;
  teamMembers: Array<{ id: string; name: string }>;
  conflictingEvents?: CalendarEvent[];
  canUpdateAppointments?: boolean;
  canCollectPayments?: boolean;
  canSendCustomerMessages?: boolean;
  canManageAppointmentMedia?: boolean;
  canOverrideScheduleConflicts?: boolean;
  onClose?: () => void;
  variant?: "standalone" | "embedded";
};

export function CalendarEventDetail({
  event,
  teamMembers,
  conflictingEvents = [],
  canUpdateAppointments = false,
  canCollectPayments = false,
  canSendCustomerMessages = false,
  canManageAppointmentMedia = false,
  canOverrideScheduleConflicts = false,
  onClose,
  variant = "standalone",
}: Props): React.ReactElement {
  const isDbAppointment = event.source === "db";
  const isInPersonQuote =
    isDbAppointment &&
    (event.appointmentType ?? "").trim().toLowerCase() === "in_person_quote";
  const appointmentId =
    event.appointmentId ??
    (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : null);
  const parsedEventStart = new Date(event.start);
  const eventDay = Number.isNaN(parsedEventStart.getTime())
    ? ""
    : formatCalendarDayKey(parsedEventStart);
  const teamLink = appointmentId
    ? teamSurfaceHref("calendar", {
        query: eventDay ? { calView: "day", cal: eventDay } : undefined,
      })
    : null;
  const notes = event.notes ?? [];
  const amountSummary = isDbAppointment
    ? formatCalendarEventAmounts(event)
    : null;
  const shellClass =
    variant === "embedded"
      ? "rounded-xl border border-slate-200 bg-white p-3"
      : "rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50";
  const normalizedStatus = (event.status ?? "").trim().toLowerCase();
  const canEditStatus =
    isDbAppointment &&
    appointmentId &&
    canUpdateAppointments &&
    normalizedStatus !== "completed" &&
    normalizedStatus !== "canceled" &&
    normalizedStatus !== "no_show";

  return (
    <div className={shellClass}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-700">
            {event.source === "db" ? "Appointment" : "Google"}
          </span>
          {isInPersonQuote ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${getCalendarEventBadgeClass(event)}`}
            >
              In-person quote
            </span>
          ) : null}
          {event.status ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${getCalendarEventBadgeClass(event)}`}
            >
              {event.status.replace(/_/gu, " ")}
            </span>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close appointment details"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-lg text-slate-600 hover:border-primary-300 hover:text-primary-700"
          >
            ×
          </button>
        ) : null}
      </div>
      <h3 className="mt-2 text-lg font-semibold text-slate-900">
        {event.title}
      </h3>
      <p className="text-sm text-slate-600">
        {formatTime(event.start)} - {formatTime(event.end)}
      </p>
      {event.address ? (
        <p className="text-xs text-slate-500">{event.address}</p>
      ) : null}
      {event.contactName ? (
        <p className="text-xs text-slate-500">Contact: {event.contactName}</p>
      ) : null}
      {event.crewNames && event.crewNames.length > 0 ? (
        <p className="text-xs text-slate-500">
          Crew: {event.crewNames.join(", ")}
        </p>
      ) : null}
      {amountSummary ? (
        <p className="text-xs text-slate-500">{amountSummary}</p>
      ) : null}
      {conflictingEvents.length > 0 ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
        >
          <div className="font-semibold">Scheduling conflict</div>
          <p className="mt-1">
            This overlaps{" "}
            {conflictingEvents.length === 1
              ? "another event"
              : `${conflictingEvents.length} other events`}
            :
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {conflictingEvents.map((conflict) => (
              <li key={conflict.id}>
                {conflict.title} ({formatTime(conflict.start)} –{" "}
                {formatTime(conflict.end)})
                {conflict.source === "google" ? " · Google event" : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Review crew capacity before confirming or rescheduling.
          </p>
        </div>
      ) : null}
      {!isDbAppointment ? (
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <div className="font-semibold">Read-only Google event</div>
          <p className="mt-1">
            This event is shown for scheduling context. Edit or remove it in
            Google Calendar; CRM appointment actions do not apply.
          </p>
        </div>
      ) : null}
      {notes.length ? (
        <div className="mt-3 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Notes
          </div>
          {notes.map((note) => (
            <div
              key={note.id}
              className="rounded-lg bg-white px-3 py-2 shadow-sm"
            >
              <div className="whitespace-pre-wrap text-sm font-semibold text-slate-900">
                {note.body}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {new Date(note.createdAt).toLocaleString(undefined, {
                  timeZone: TEAM_TIME_ZONE,
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {isDbAppointment && appointmentId ? (
        <>
          {!canUpdateAppointments ? (
            <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              You have read-only calendar access. Appointment changes and notes
              require update permission.
            </p>
          ) : null}
          <CalendarAppointmentActions
            appointmentId={appointmentId}
            appointmentType={event.appointmentType ?? null}
            start={event.start}
            version={event.version ?? null}
            quotedTotalCents={event.quotedTotalCents ?? null}
            finalTotalCents={event.finalTotalCents ?? null}
            isQuoteOnly={isInPersonQuote}
            canEditStatus={Boolean(canEditStatus)}
            canUpdateAppointments={canUpdateAppointments}
            canCollectPayments={canCollectPayments}
            canSendCustomerMessages={canSendCustomerMessages}
            canManageAppointmentMedia={canManageAppointmentMedia}
            canOverrideScheduleConflicts={canOverrideScheduleConflicts}
            teamMembers={teamMembers}
          />
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {teamLink ? (
          <a
            href={teamLink}
            className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-white"
          >
            Open in Team
          </a>
        ) : null}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
