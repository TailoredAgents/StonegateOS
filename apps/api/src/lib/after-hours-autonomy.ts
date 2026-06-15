import { DateTime } from "luxon";

export const AFTER_HOURS_AUTONOMY_TIMEZONE =
  process.env["APPOINTMENT_TIMEZONE"] ??
  process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
  "America/New_York";

const AUTONOMY_START_MINUTES = 18 * 60 + 30;
const AUTONOMY_END_MINUTES = 7 * 60 + 30;
const NIGHT_MIN_BOOKING_MINUTES = 10 * 60;
const WEEKDAY_START_MINUTES = 8 * 60;
const WEEKDAY_LAST_STANDARD_START_MINUTES = 16 * 60 + 30;
const WEEKDAY_LATE_START_MINUTES = 17 * 60 + 30;
const SATURDAY_START_MINUTES = 9 * 60;
const SATURDAY_LAST_START_MINUTES = 13 * 60;
const APPOINTMENT_DURATION_MINUTES = 60;

const APPROVED_LATE_CITY_KEYS = new Set([
  "kennesaw",
  "acworth",
  "woodstock",
  "canton",
  "holly springs",
]);

export type BookingRuleResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "sunday_blocked"
        | "outside_booking_hours"
        | "late_city_required"
        | "night_minimum_start"
        | "invalid_start";
      message: string;
    };

function normalizeCity(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function localMinutes(value: DateTime): number {
  return value.hour * 60 + value.minute;
}

function resolveZone(timezone?: string | null): string {
  const candidate = typeof timezone === "string" && timezone.trim().length > 0 ? timezone.trim() : AFTER_HOURS_AUTONOMY_TIMEZONE;
  return DateTime.local().setZone(candidate).isValid ? candidate : AFTER_HOURS_AUTONOMY_TIMEZONE;
}

export function isAfterHoursAutonomyActive(input: {
  at?: Date | string | null;
  timezone?: string | null;
} = {}): boolean {
  const zone = resolveZone(input.timezone);
  const local =
    typeof input.at === "string"
      ? DateTime.fromISO(input.at, { setZone: true }).setZone(zone)
      : input.at instanceof Date
        ? DateTime.fromJSDate(input.at, { zone: "utc" }).setZone(zone)
        : DateTime.now().setZone(zone);
  if (!local.isValid) return false;
  if (local.weekday === 7) return true;
  const minutes = localMinutes(local);
  return minutes >= AUTONOMY_START_MINUTES || minutes < AUTONOMY_END_MINUTES;
}

function nextServiceDayAt10(local: DateTime): DateTime {
  let target: DateTime;
  const minutes = localMinutes(local);

  if (local.weekday === 7) {
    target = local.plus({ days: 1 });
  } else if (minutes < AUTONOMY_END_MINUTES) {
    target = local;
  } else {
    target = local.plus({ days: 1 });
  }

  while (target.weekday === 7) {
    target = target.plus({ days: 1 });
  }

  return target.startOf("day").plus({ minutes: NIGHT_MIN_BOOKING_MINUTES });
}

export function getEarliestAfterHoursBookingStart(input: {
  conversationAt: Date | string;
  timezone?: string | null;
}): Date {
  const zone = resolveZone(input.timezone);
  const local =
    typeof input.conversationAt === "string"
      ? DateTime.fromISO(input.conversationAt, { setZone: true }).setZone(zone)
      : DateTime.fromJSDate(input.conversationAt, { zone: "utc" }).setZone(zone);
  const validLocal = local.isValid ? local : DateTime.now().setZone(zone);
  return nextServiceDayAt10(validLocal).toUTC().toJSDate();
}

export function isApprovedLateBookingCity(city: string | null | undefined): boolean {
  return APPROVED_LATE_CITY_KEYS.has(normalizeCity(city));
}

export function validateAutonomousBookingStart(input: {
  startAt: Date | string;
  city?: string | null;
  timezone?: string | null;
  durationMinutes?: number | null;
  conversationAt?: Date | string | null;
}): BookingRuleResult {
  const zone = resolveZone(input.timezone);
  const startLocal =
    typeof input.startAt === "string"
      ? DateTime.fromISO(input.startAt, { setZone: true }).setZone(zone)
      : DateTime.fromJSDate(input.startAt, { zone: "utc" }).setZone(zone);
  if (!startLocal.isValid) {
    return { ok: false, code: "invalid_start", message: "Invalid appointment start time." };
  }

  const durationMinutes =
    typeof input.durationMinutes === "number" && Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
      ? input.durationMinutes
      : APPOINTMENT_DURATION_MINUTES;
  const endLocal = startLocal.plus({ minutes: durationMinutes });
  const minutes = localMinutes(startLocal);

  if (startLocal.minute !== 0 && startLocal.minute !== 30) {
    return { ok: false, code: "invalid_start", message: "Appointment starts must be on the hour or half hour." };
  }

  if (startLocal.weekday === 7) {
    return { ok: false, code: "sunday_blocked", message: "Sunday appointments are not allowed." };
  }

  if (input.conversationAt && isAfterHoursAutonomyActive({ at: input.conversationAt, timezone: zone })) {
    const earliest = DateTime.fromJSDate(
      getEarliestAfterHoursBookingStart({ conversationAt: input.conversationAt, timezone: zone }),
      { zone: "utc" },
    ).setZone(zone);
    if (startLocal < earliest) {
      return {
        ok: false,
        code: "night_minimum_start",
        message: "After-hours autonomous bookings must start at 10:00 AM or later on the next service day.",
      };
    }
  }

  if (startLocal.weekday === 6) {
    if (minutes >= SATURDAY_START_MINUTES && minutes <= SATURDAY_LAST_START_MINUTES && endLocal <= startLocal.startOf("day").plus({ hours: 14 })) {
      return { ok: true };
    }
    return { ok: false, code: "outside_booking_hours", message: "Saturday appointments must start between 9:00 AM and 1:00 PM." };
  }

  if (startLocal.weekday >= 1 && startLocal.weekday <= 5) {
    if (
      minutes >= WEEKDAY_START_MINUTES &&
      minutes <= WEEKDAY_LAST_STANDARD_START_MINUTES &&
      endLocal <= startLocal.startOf("day").plus({ hours: 17, minutes: 30 })
    ) {
      return { ok: true };
    }
    if (minutes === WEEKDAY_LATE_START_MINUTES) {
      if (isApprovedLateBookingCity(input.city)) {
        return { ok: true };
      }
      return {
        ok: false,
        code: "late_city_required",
        message: "5:30 PM appointments are only allowed in Kennesaw, Acworth, Woodstock, Canton, or Holly Springs.",
      };
    }
  }

  return { ok: false, code: "outside_booking_hours", message: "Appointment start time is outside allowed junk removal hours." };
}

export function getAutonomousBookingDurationMinutes(): number {
  return APPOINTMENT_DURATION_MINUTES;
}
