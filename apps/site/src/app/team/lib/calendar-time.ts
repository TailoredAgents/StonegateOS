export const TEAM_TIME_ZONE = "America/New_York";

export type CalendarView = "day" | "week" | "month";

export function resolveCalendarDefaultView(
  roleSlug: string | null | undefined,
): Exclude<CalendarView, "month"> {
  return roleSlug?.trim().toLowerCase() === "crew" ? "day" : "week";
}

type CalendarDayParts = {
  year: number;
  month: number;
  day: number;
};

const zonedDateTimeFormatter = new Intl.DateTimeFormat("en-US-u-hc-h23", {
  timeZone: TEAM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseCalendarDayKey(dayKey: string): CalendarDayParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

export function formatCalendarDayKey(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return year && month && day ? `${year}-${month}-${day}` : "";
}

export function normalizeCalendarDayKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseCalendarDayKey(value);
  return parsed
    ? `${String(parsed.year).padStart(4, "0")}-${pad(parsed.month)}-${pad(parsed.day)}`
    : null;
}

export function addCalendarDays(dayKey: string, deltaDays: number): string {
  const parsed = parseCalendarDayKey(dayKey);
  if (!parsed || !Number.isInteger(deltaDays)) return dayKey;
  const next = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + deltaDays, 12),
  );
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function addCalendarMonths(dayKey: string, deltaMonths: number): string {
  const parsed = parseCalendarDayKey(dayKey);
  if (!parsed || !Number.isInteger(deltaMonths)) return dayKey;

  const monthStart = new Date(
    Date.UTC(parsed.year, parsed.month - 1 + deltaMonths, 1, 12),
  );
  const nextMonthStart = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 12),
  );
  const lastDay = new Date(nextMonthStart.getTime() - 24 * 60 * 60 * 1_000).getUTCDate();
  const day = Math.min(parsed.day, lastDay);
  return `${String(monthStart.getUTCFullYear()).padStart(4, "0")}-${pad(monthStart.getUTCMonth() + 1)}-${pad(day)}`;
}

export function getCalendarWeekStart(dayKey: string): string {
  const parsed = parseCalendarDayKey(dayKey);
  if (!parsed) return dayKey;
  const weekday = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12),
  ).getUTCDay();
  return addCalendarDays(dayKey, -weekday);
}

export function getCalendarMonthGridStart(dayKey: string): string {
  const parsed = parseCalendarDayKey(dayKey);
  if (!parsed) return dayKey;
  const first = `${String(parsed.year).padStart(4, "0")}-${pad(parsed.month)}-01`;
  return getCalendarWeekStart(first);
}

function zonedParts(date: Date): Required<CalendarDayParts> & {
  hour: number;
  minute: number;
  second: number;
} | null {
  const parts = zonedDateTimeFormatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const result = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

/** Convert Eastern local midnight to its exact UTC instant, including DST. */
export function calendarDayStartUtc(dayKey: string): Date | null {
  const parsed = parseCalendarDayKey(dayKey);
  if (!parsed) return null;

  const targetAsUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0);
  let candidateMs = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidateMs));
    if (!actual) return null;
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetAsUtc - actualAsUtc;
    candidateMs += correction;
    if (correction === 0) break;
  }

  const result = new Date(candidateMs);
  return formatCalendarDayKey(result) === dayKey ? result : null;
}

export function getCalendarUtcRange(
  anchorDay: string,
  view: CalendarView,
): { start: Date; end: Date } | null {
  if (!parseCalendarDayKey(anchorDay)) return null;

  const startDay =
    view === "day"
      ? anchorDay
      : view === "week"
        ? getCalendarWeekStart(anchorDay)
        : getCalendarMonthGridStart(anchorDay);
  const endDay = addCalendarDays(startDay, view === "day" ? 1 : view === "week" ? 7 : 42);
  const start = calendarDayStartUtc(startDay);
  const end = calendarDayStartUtc(endDay);
  return start && end ? { start, end } : null;
}

/** Noon UTC is stable for rendering a date-only key in Eastern time. */
export function calendarDayKeyForLabel(dayKey: string): Date | null {
  const parsed = parseCalendarDayKey(dayKey);
  return parsed
    ? new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12))
    : null;
}
