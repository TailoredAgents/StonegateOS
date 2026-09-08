import { and, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Appointment types that represent a quote visit rather than completed,
 * revenue-producing service work.
 *
 * `estimate` is intentionally not in this list. It is the legacy default used
 * by real service jobs and must continue to reconcile with commissions and
 * payouts until those records are migrated explicitly.
 */
export const QUOTE_ONLY_APPOINTMENT_TYPES = [
  "in_person_quote",
  "in_person_estimate",
] as const;

export type QuoteOnlyAppointmentType =
  (typeof QUOTE_ONLY_APPOINTMENT_TYPES)[number];

const QUOTE_ONLY_APPOINTMENT_TYPE_SET = new Set<string>(
  QUOTE_ONLY_APPOINTMENT_TYPES,
);

export function normalizeAppointmentType(
  value: string | null | undefined,
): string {
  return value?.trim().toLowerCase() ?? "";
}

export function isQuoteOnlyAppointmentType(
  value: string | null | undefined,
): boolean {
  return QUOTE_ONLY_APPOINTMENT_TYPE_SET.has(normalizeAppointmentType(value));
}

/**
 * True for a non-empty appointment type that represents performed service.
 * This deliberately includes the legacy `estimate` type and other historical
 * service labels while excluding the two explicit quote-only visit types.
 */
export function isServiceWorkAppointmentType(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeAppointmentType(value);
  return normalized.length > 0 && !isQuoteOnlyAppointmentType(normalized);
}

/** Database equivalent of `isServiceWorkAppointmentType`. */
export function serviceWorkAppointmentTypePredicate(column: SQLWrapper): SQL {
  const normalized = sql<string>`lower(regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;
  return and(
    sql`${normalized} <> ''`,
    notInArray(normalized, [...QUOTE_ONLY_APPOINTMENT_TYPES]),
  )!;
}
