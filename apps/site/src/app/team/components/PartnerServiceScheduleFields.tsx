"use client";

import React from "react";
import { TEAM_TIME_ZONE } from "../lib/calendar-time";
import { requestedPartnerDate } from "../lib/partner-request-presentation";
import { TEAM_INPUT_COMPACT } from "./team-ui";

type PreferredWindow = {
  localDate: string;
  timeOfDay: string;
  timezone?: string;
};

export function partnerStartTimeLabel(time: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

const TIME_GROUPS = [
  { label: "Overnight", from: 0, to: 6 },
  { label: "Morning", from: 6, to: 12 },
  { label: "Afternoon", from: 12, to: 18 },
  { label: "Evening", from: 18, to: 24 },
].map(({ label, from, to }) => ({
  label,
  times: Array.from({ length: (to - from) * 2 }, (_, index) => {
    const minutes = from * 60 + index * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 === 0 ? "00" : "30"}`;
  }),
}));

function requestedDates(windows: readonly PreferredWindow[]) {
  const grouped = new Map<
    string,
    PreferredWindow & {
      preferences: string[];
      selectable: boolean;
      explanation: string;
    }
  >();
  for (const window of windows) {
    const timezone = window.timezone || TEAM_TIME_ZONE;
    const key = `${window.localDate}:${timezone}`;
    const preference =
      window.timeOfDay === "anytime"
        ? "Client is flexible on time"
        : `Client prefers ${window.timeOfDay.replaceAll("_", " ").toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.preferences.includes(preference))
        existing.preferences.push(preference);
      continue;
    }
    const parsed = new Date(`${window.localDate}T12:00:00Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}$/u.test(window.localDate) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === window.localDate;
    const otherTimezone = timezone !== TEAM_TIME_ZONE;
    grouped.set(key, {
      ...window,
      preferences: [preference],
      selectable: valid && !otherTimezone,
      explanation: otherTimezone
        ? `Requested in ${timezone}. Enter the matching Eastern date below.`
        : !valid
          ? "This requested date needs review. Enter a valid service date below."
          : "",
    });
  }
  return Array.from(grouped.values());
}

/** Controlled fields: choosing a requested date never chooses a time or submits. */
export function PartnerServiceScheduleFields({
  preferredWindows,
  date,
  time,
  disabled,
  timeRef,
  onChooseDate,
  onDateChange,
  onTimeChange,
}: {
  preferredWindows: readonly PreferredWindow[];
  date: string;
  time: string;
  disabled: boolean;
  timeRef: React.RefObject<HTMLSelectElement | null>;
  onChooseDate: (date: string) => void;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
}) {
  const choices = requestedDates(preferredWindows);
  const [customDate, setCustomDate] = React.useState(
    () =>
      !!date &&
      !choices.some((choice) => choice.selectable && choice.localDate === date),
  );
  const inputRef = React.useRef<HTMLInputElement>(null);
  const focusCustomDate = React.useRef(false);
  const descriptionId = React.useId();
  const manual = customDate || !choices.some((choice) => choice.selectable);
  React.useEffect(() => {
    if (manual && focusCustomDate.current) {
      inputRef.current?.focus();
      focusCustomDate.current = false;
    }
  }, [manual]);
  const standardTime = TIME_GROUPS.some((group) => group.times.includes(time));

  return (
    <>
      <fieldset className="min-w-0 space-y-3" disabled={disabled}>
        <legend className="mb-2 text-sm font-semibold text-slate-800">
          Service date
        </legend>
        {choices.length ? (
          <>
            <p className="text-xs text-slate-500">Client’s requested dates</p>
            <ul className="grid min-w-0 grid-cols-2 gap-2">
              {choices.map((choice, index) => {
                const selected =
                  choice.selectable && !manual && date === choice.localDate;
                const preferenceId = `${descriptionId}-${index}`;
                const explanationId = `${preferenceId}-explanation`;
                return (
                  <li
                    key={`${choice.localDate}:${choice.timezone || TEAM_TIME_ZONE}`}
                    className="min-w-0"
                  >
                    <button
                      type="button"
                      aria-label={`Use date: ${requestedPartnerDate(choice.localDate)}`}
                      aria-pressed={selected}
                      aria-describedby={`${preferenceId}${choice.explanation ? ` ${explanationId}` : ""}`}
                      disabled={disabled || !choice.selectable}
                      onClick={() => {
                        setCustomDate(false);
                        onChooseDate(choice.localDate);
                      }}
                      className={`min-h-11 w-full rounded-lg border px-3 py-2.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:text-slate-500 ${selected ? "border-teal-600 bg-teal-50 text-teal-950" : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"}`}
                    >
                      <span className="flex items-start justify-between gap-1 font-semibold">
                        <span>{requestedPartnerDate(choice.localDate)}</span>
                        {selected ? <span aria-hidden="true">✓</span> : null}
                      </span>
                      <span
                        id={preferenceId}
                        className="mt-1 block text-xs leading-5 text-slate-600"
                      >
                        {choice.preferences.join("; ")}
                      </span>
                    </button>
                    {choice.explanation ? (
                      <p
                        id={explanationId}
                        className="mt-1 text-xs leading-5 text-slate-500"
                      >
                        {choice.explanation}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {manual ? (
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            <span className={choices.length ? "" : "sr-only"}>
              Service date
            </span>
            <input
              ref={inputRef}
              type="date"
              name="preferredDate"
              required
              value={date}
              onChange={(event) => onDateChange(event.target.value)}
              className={TEAM_INPUT_COMPACT}
            />
          </label>
        ) : (
          <>
            <input type="hidden" name="preferredDate" value={date} />
            <button
              type="button"
              className="min-h-11 text-sm font-medium text-teal-800 underline underline-offset-4"
              onClick={() => {
                focusCustomDate.current = true;
                setCustomDate(true);
              }}
            >
              Choose another date
            </button>
          </>
        )}
      </fieldset>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-semibold text-slate-800">
        <span>Start time (Eastern)</span>
        <select
          ref={timeRef}
          name="startTime"
          required
          value={time}
          disabled={disabled}
          onChange={(event) => onTimeChange(event.target.value)}
          className={`${TEAM_INPUT_COMPACT} h-11 w-full font-normal`}
        >
          <option value="" disabled>
            Select a start time
          </option>
          {time && !standardTime ? (
            <option value={time}>{partnerStartTimeLabel(time)}</option>
          ) : null}
          {TIME_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.times.map((value) => (
                <option key={value} value={value}>
                  {partnerStartTimeLabel(value)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}
