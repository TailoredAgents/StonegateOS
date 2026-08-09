import { DateTime } from "luxon";

export const APPOINTMENT_TIME_ZONE = "America/New_York";

export type EasternAppointmentTimeResult =
  | { ok: true; value: Date }
  | {
      ok: false;
      code: "invalid_start_time" | "ambiguous_start_time";
      message: string;
    };

function localDateTimeKey(value: DateTime): string {
  return value.setZone(APPOINTMENT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm");
}

function isAmbiguousLocalTime(value: DateTime, requested: string): boolean {
  const utc = value.toUTC();
  return [-60, 60].some((minutes) => {
    const candidate = utc.plus({ minutes }).setZone(APPOINTMENT_TIME_ZONE);
    return (
      localDateTimeKey(candidate) === requested &&
      candidate.offset !== value.offset
    );
  });
}

/**
 * Converts an explicit Eastern wall-clock time without silently shifting DST
 * gaps or guessing which repeated fall-back hour the operator intended.
 */
export function resolveEasternAppointmentTime(
  preferredDate: string,
  startTime: string,
): EasternAppointmentTimeResult {
  const requested = `${preferredDate}T${startTime}`;
  const value = DateTime.fromISO(requested, {
    zone: APPOINTMENT_TIME_ZONE,
    setZone: true,
  });
  if (!value.isValid || localDateTimeKey(value) !== requested) {
    return {
      ok: false,
      code: "invalid_start_time",
      message:
        "That Eastern time does not exist because of daylight saving time. Choose a different time.",
    };
  }
  if (isAmbiguousLocalTime(value, requested)) {
    return {
      ok: false,
      code: "ambiguous_start_time",
      message:
        "That Eastern time occurs twice because daylight saving time is ending. Choose a time before 1:00 AM or after 2:00 AM.",
    };
  }
  return { ok: true, value: value.toUTC().toJSDate() };
}

/** Converts a Google all-day date boundary to the matching Eastern midnight. */
export function resolveEasternDayBoundary(
  date: string,
): EasternAppointmentTimeResult {
  return resolveEasternAppointmentTime(date, "00:00");
}
