export const PORTAL_V2_CURRENCY = "USD" as const;
export const PORTAL_V2_CURRENCY_MINOR_UNIT = 2 as const;

export type PortalV2MoneyDto = Readonly<{
  amountMinor: number;
  currency: string;
  minorUnit: typeof PORTAL_V2_CURRENCY_MINOR_UNIT;
}>;

const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/u;

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Strict RFC3339 input with an explicit UTC designator or numeric offset. */
export function parsePortalV2Rfc3339(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) {
      return null;
    }
    offsetMinutes =
      (offsetHour * 60 + offsetMinute) * (match[9] === "+" ? 1 : -1);
  }

  const millisecond = Number(`${fraction}000`.slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const instant = new Date(local.getTime() - offsetMinutes * 60_000);
  return Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() >= 1 &&
    instant.getUTCFullYear() <= 9_999
    ? instant
    : null;
}

export function isPortalV2Rfc3339(value: unknown): value is string {
  return parsePortalV2Rfc3339(value) !== null;
}

export function toPortalV2Rfc3339(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("The portal timestamp is invalid.");
  }
  return value.toISOString();
}

/** Returns the runtime's canonical IANA zone name, or null for an invalid zone. */
export function normalizePortalV2Timezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timezone = value.trim();
  if (
    timezone.length === 0 ||
    timezone.length > 64 ||
    !TIMEZONE_PATTERN.test(timezone)
  ) {
    return null;
  }
  try {
    const canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
    return canonical && canonical.length <= 64 ? canonical : null;
  } catch {
    return null;
  }
}

export function createPortalV2MoneyDto(
  amountMinor: unknown,
  currencyValue: unknown = PORTAL_V2_CURRENCY,
): PortalV2MoneyDto {
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new TypeError(
      "The portal money amount must use integer minor units.",
    );
  }
  const currency =
    typeof currencyValue === "string"
      ? currencyValue.trim().toUpperCase()
      : "";
  if (!ISO_CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("The portal money currency must be an ISO 4217 code.");
  }
  return Object.freeze({
    amountMinor,
    currency,
    minorUnit: PORTAL_V2_CURRENCY_MINOR_UNIT,
  });
}

export function parsePortalV2MoneyDto(value: unknown): PortalV2MoneyDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "amountMinor,currency,minorUnit" ||
    typeof record["currency"] !== "string" ||
    !ISO_CURRENCY_PATTERN.test(record["currency"]) ||
    record["minorUnit"] !== PORTAL_V2_CURRENCY_MINOR_UNIT ||
    typeof record["amountMinor"] !== "number" ||
    !Number.isSafeInteger(record["amountMinor"])
  ) {
    return null;
  }
  return createPortalV2MoneyDto(record["amountMinor"], record["currency"]);
}
