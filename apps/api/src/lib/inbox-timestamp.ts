export type InboxTimestampValue = Date | string | null | undefined;

/**
 * Drizzle maps declared timestamp columns to Date objects, but PostgreSQL
 * expressions built with `sql` may still be returned by the driver as
 * timestamp strings. Normalize both shapes before building Inbox revisions or
 * responses so polling cannot crash on a valid database value.
 */
export function toInboxIso(value: InboxTimestampValue): string | null {
  if (value == null) return null;

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("Inbox timestamp is not a valid database timestamp.");
  }

  return parsed.toISOString();
}
