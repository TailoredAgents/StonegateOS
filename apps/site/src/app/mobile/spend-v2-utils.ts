const EASTERN_TIME_ZONE = "America/New_York";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type ExpenseReceiptContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "application/pdf";

function receiptBytesAscii(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  let value = "";
  for (let offset = start; offset < start + length; offset += 1) {
    value += String.fromCharCode(bytes[offset] ?? 0);
  }
  return value;
}

function detectExpenseReceiptHeifType(
  bytes: Uint8Array,
): "image/heic" | "image/heif" | null {
  if (bytes.length < 12 || receiptBytesAscii(bytes, 4, 4) !== "ftyp") {
    return null;
  }
  const brands = new Set<string>([receiptBytesAscii(bytes, 8, 4)]);
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.add(receiptBytesAscii(bytes, offset, 4));
  }
  if (brands.has("avif") || brands.has("avis")) return null;
  if (["heic", "heix", "hevc", "hevx"].some((brand) => brands.has(brand))) {
    return "image/heic";
  }
  return ["mif1", "msf1"].some((brand) => brands.has(brand))
    ? "image/heif"
    : null;
}

/**
 * Detect the receipt container from its immutable bytes. Browser File.type and
 * filename extensions are only picker hints and are not authoritative.
 */
export function detectExpenseReceiptContentType(
  input: ArrayBuffer | Uint8Array,
): ExpenseReceiptContentType | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 5 && receiptBytesAscii(bytes, 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    receiptBytesAscii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    receiptBytesAscii(bytes, 0, 4) === "RIFF" &&
    receiptBytesAscii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return detectExpenseReceiptHeifType(bytes);
}

export function easternDateKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const key = `${part("year")}-${part("month")}-${part("day")}`;
  return DATE_ONLY_PATTERN.test(key) ? key : value.toISOString().slice(0, 10);
}

export function addDateKeyDays(dateKey: string, days: number): string {
  if (!DATE_ONLY_PATTERN.test(dateKey)) return dateKey;
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function mondayForDateKey(dateKey: string): string {
  if (!DATE_ONLY_PATTERN.test(dateKey)) return dateKey;
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  const weekday = date.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return addDateKeyDays(dateKey, -daysSinceMonday);
}

export function moneyInputToCents(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/gu, "");
  if (!/^(?:\d+|\d*\.\d{1,2})$/u.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 100_000_000
    ? cents
    : null;
}

export function centsToMoneyInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatExpenseMoney(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function formatExpensePercent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(1)}%`;
}

export function expenseAllocationTotal(
  allocations: Array<{ amountCents: number | null }>,
): number | null {
  if (allocations.some((allocation) => allocation.amountCents === null)) {
    return null;
  }
  return allocations.reduce(
    (sum, allocation) => sum + (allocation.amountCents ?? 0),
    0,
  );
}

export function expenseErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const fieldErrors = record["fieldErrors"];
  if (fieldErrors && typeof fieldErrors === "object") {
    const first = Object.values(fieldErrors as Record<string, unknown>).find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (typeof first === "string") return first;
  }
  for (const key of ["message", "error", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}
