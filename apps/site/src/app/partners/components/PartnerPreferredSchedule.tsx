"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { PartnerPreferredScheduleValues } from "../lib/booking-schedule";
import {
  PARTNER_SCHEDULE_ASSISTANCE_OPTIONS,
  type PartnerScheduleAssistancePreference,
} from "../lib/partner-scheduling-assistance";
import { partnerFieldClass } from "./PartnerPortalUi";

export type PartnerPreferredScheduleFormValues =
  PartnerPreferredScheduleValues & {
    scheduleAssistancePreference: PartnerScheduleAssistancePreference;
  };

type Props = {
  value: PartnerPreferredScheduleFormValues;
  onChange: <K extends keyof PartnerPreferredScheduleFormValues>(
    key: K,
    value: PartnerPreferredScheduleFormValues[K],
  ) => void;
  fieldErrors: Record<string, string>;
  minimumDate: string;
  maximumDate: string;
  timezoneLabel: string;
  formatDate: (date: string) => string;
  completionDeadline: React.ReactNode;
  supportPhoneE164: string;
  supportPhoneDisplay: string;
};

const DATE_ROWS = [
  {
    dateKey: "preferredDateOne",
    timeKey: "preferredTimeOfDay",
    dateId: "partner-book-preferred-date-1",
    timeId: "partner-book-preferred-time",
    dateLabel: "Preferred date",
    timeLabel: "Preferred time",
  },
  {
    dateKey: "preferredDateTwo",
    timeKey: "preferredTimeOfDayTwo",
    dateId: "partner-book-preferred-date-2",
    timeId: "partner-book-preferred-time-2",
    dateLabel: "Alternative date 1",
    timeLabel: "Alternative time 1",
  },
  {
    dateKey: "preferredDateThree",
    timeKey: "preferredTimeOfDayThree",
    dateId: "partner-book-preferred-date-3",
    timeId: "partner-book-preferred-time-3",
    dateLabel: "Alternative date 2",
    timeLabel: "Alternative time 2",
  },
] as const;
const TIME_OPTIONS = [
  { value: "anytime", label: "Any time" },
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
] as const;
const HELP_ORDER = ["none", "callback", "waitlist"];
const HELP_OPTIONS = [...PARTNER_SCHEDULE_ASSISTANCE_OPTIONS].sort(
  (left, right) =>
    HELP_ORDER.indexOf(left.value) - HELP_ORDER.indexOf(right.value),
);

function belongsTo(field: string, root: string): boolean {
  return field === root || field.startsWith(`${root}.`);
}

function ErrorMessages({ id, messages }: { id: string; messages: string[] }) {
  return messages.length ? (
    <div id={id} className="space-y-1 text-sm font-medium text-rose-700">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  ) : null;
}

function ScheduleDetails({
  id,
  title,
  summary,
  hasErrors,
  fieldErrors,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  hasErrors: boolean;
  fieldErrors: Record<string, string>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDetailsElement>(null);
  React.useEffect(() => {
    // Native state preserves edits and avoids delayed toggle events hiding errors.
    if (hasErrors && ref.current) ref.current.open = true;
  }, [hasErrors, fieldErrors]);
  return (
    <details
      id={id}
      ref={ref}
      tabIndex={-1}
      className="group/schedule-detail border-t border-slate-200"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {title}{" "}
            <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <span className="mt-0.5 block break-words text-xs font-normal text-slate-600 [overflow-wrap:anywhere]">
            {summary}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/schedule-detail:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

export function PartnerPreferredSchedule({
  value,
  onChange,
  fieldErrors,
  minimumDate,
  maximumDate,
  timezoneLabel,
  formatDate,
  completionDeadline,
  supportPhoneE164,
  supportPhoneDisplay,
}: Props) {
  const entries = Object.entries(fieldErrors).map(
    ([field, message]) =>
      [field.replace(/\[(\d+)\]/gu, ".$1"), message] as const,
  );
  const messagesMatching = (matches: (field: string) => boolean): string[] => [
    ...new Set(
      entries.filter(([field]) => matches(field)).map(([, message]) => message),
    ),
  ];
  const aggregateErrors = messagesMatching(
    (field) => field === "preferredWindows" || field === "preferredTimezone",
  );
  let nextWindowIndex = 0;
  const rows = DATE_ROWS.map((row) => ({
    ...row,
    windowIndex: value[row.dateKey].trim() ? nextWindowIndex++ : undefined,
  }));
  const rowErrors = (row: (typeof rows)[number]) => {
    const root =
      row.windowIndex === undefined
        ? undefined
        : `preferredWindows.${row.windowIndex}`;
    return {
      date: messagesMatching(
        (field) =>
          belongsTo(field, row.dateKey) ||
          Boolean(
            root &&
              belongsTo(field, root) &&
              !belongsTo(field, `${root}.timeOfDay`),
          ),
      ),
      time: messagesMatching(
        (field) =>
          belongsTo(field, row.timeKey) ||
          Boolean(root && belongsTo(field, `${root}.timeOfDay`)),
      ),
    };
  };
  const unmatchedWindowErrors = messagesMatching((field) => {
    if (!field.startsWith("preferredWindows.")) return false;
    const index = /^preferredWindows\.(\d+)(?:\.|$)/u.exec(field)?.[1];
    return (
      index === undefined ||
      !rows.some((row) => row.windowIndex === Number(index))
    );
  });
  const alternativeErrors = rows.slice(1).flatMap((row) => {
    const errors = rowErrors(row);
    return [...errors.date, ...errors.time];
  });
  const assistanceErrors = messagesMatching((field) =>
    belongsTo(field, "scheduleAssistancePreference"),
  );
  const selectedHelp = HELP_OPTIONS.find(
    (option) => option.value === value.scheduleAssistancePreference,
  );
  const alternativeSummary =
    rows
      .slice(1)
      .filter((row) => value[row.dateKey].trim())
      .map((row) => {
        const date = value[row.dateKey];
        let label = date;
        try {
          label = formatDate(date);
        } catch {
          /* Keep an invalid saved date visible for correction. */
        }
        const timeLabel =
          TIME_OPTIONS.find((option) => option.value === value[row.timeKey])
            ?.label ?? value[row.timeKey];
        return `${label} · ${timeLabel}`;
      })
      .join("; ") || "Add up to two backup dates";

  const renderRow = (row: (typeof rows)[number]) => {
    const errors = rowErrors(row);
    const dateDescription =
      [
        errors.date.length ? `${row.dateId}-error` : null,
        aggregateErrors.length ? "partner-book-preferred-error" : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined;
    const timeDescription =
      [
        errors.time.length ? `${row.timeId}-error` : null,
        aggregateErrors.length ? "partner-book-preferred-error" : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <div key={row.dateKey} className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label
            htmlFor={row.dateId}
            className="block text-sm font-semibold text-slate-700"
          >
            {row.dateLabel}
            <input
              id={row.dateId}
              type="date"
              min={minimumDate}
              max={maximumDate}
              required={row.dateKey === "preferredDateOne"}
              value={value[row.dateKey]}
              onChange={(event) => onChange(row.dateKey, event.target.value)}
              data-partner-preferred-index={row.windowIndex}
              className={`${partnerFieldClass} font-normal`}
              aria-invalid={Boolean(
                errors.date.length || aggregateErrors.length,
              )}
              aria-describedby={dateDescription}
            />
          </label>
          <ErrorMessages id={`${row.dateId}-error`} messages={errors.date} />
        </div>
        <div className="min-w-0 space-y-2">
          <label
            htmlFor={row.timeId}
            className="block text-sm font-semibold text-slate-700"
          >
            {row.timeLabel}
          </label>
          <select
            id={row.timeId}
            value={value[row.timeKey]}
            onChange={(event) =>
              onChange(
                row.timeKey,
                event.target
                  .value as PartnerPreferredScheduleValues["preferredTimeOfDay"],
              )
            }
            data-partner-preferred-index={row.windowIndex}
            className={`${partnerFieldClass} font-normal`}
            aria-invalid={Boolean(errors.time.length || aggregateErrors.length)}
            aria-describedby={timeDescription}
          >
            {TIME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ErrorMessages id={`${row.timeId}-error`} messages={errors.time} />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-slate-600">
        Choose a date and time that work for you. Stonegate will review your
        request and confirm the appointment.
      </p>
      <ErrorMessages
        id="partner-book-preferred-error"
        messages={aggregateErrors}
      />
      {rows.slice(0, 1).map(renderRow)}
      <p className="text-xs leading-5 text-slate-500">
        Times shown in {timezoneLabel}.
      </p>
      <ScheduleDetails
        id="partner-book-alternative-dates"
        title="Alternative dates"
        summary={alternativeSummary}
        hasErrors={Boolean(
          aggregateErrors.length ||
            alternativeErrors.length ||
            unmatchedWindowErrors.length,
        )}
        fieldErrors={fieldErrors}
      >
        {rows.slice(1).map(renderRow)}
        <ErrorMessages
          id="partner-book-alternative-error"
          messages={unmatchedWindowErrors}
        />
      </ScheduleDetails>
      {completionDeadline}
      <ScheduleDetails
        id="partner-book-scheduling-help"
        title="Scheduling help"
        summary={
          value.scheduleAssistancePreference === "none"
            ? "Ask about timing or an earlier opening"
            : (selectedHelp?.label ?? "Ask about timing or an earlier opening")
        }
        hasErrors={Boolean(assistanceErrors.length)}
        fieldErrors={fieldErrors}
      >
        <label
          htmlFor="partner-book-schedule-assistance"
          className="block text-sm font-semibold text-slate-700"
        >
          Follow-up preference
        </label>
        <select
          id="partner-book-schedule-assistance"
          value={value.scheduleAssistancePreference}
          onChange={(event) =>
            onChange(
              "scheduleAssistancePreference",
              event.target.value as PartnerScheduleAssistancePreference,
            )
          }
          className={`${partnerFieldClass} font-normal`}
          aria-invalid={Boolean(assistanceErrors.length)}
          aria-describedby={
            [
              selectedHelp ? "partner-book-schedule-assistance-detail" : null,
              assistanceErrors.length
                ? "partner-book-schedule-assistance-error"
                : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
        >
          {HELP_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selectedHelp ? (
          <p
            id="partner-book-schedule-assistance-detail"
            className="text-xs leading-5 text-slate-600"
          >
            {selectedHelp.detail}
          </p>
        ) : null}
        <ErrorMessages
          id="partner-book-schedule-assistance-error"
          messages={assistanceErrors}
        />
      </ScheduleDetails>
      <p className="text-sm text-slate-600">
        Need help with scheduling?{" "}
        <a
          href={`tel:${supportPhoneE164}`}
          className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline underline-offset-4"
        >
          Call {supportPhoneDisplay}
        </a>
        .
      </p>
    </div>
  );
}
