import { DateTime } from "luxon";

/** Date inputs describe a local service day, not midnight UTC. */
export function parsePartnerJobDateBoundary(
  value: string | null,
  end: boolean,
  timezone = "America/New_York",
): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const day = DateTime.fromISO(value, { zone: timezone }).startOf("day");
    if (!day.isValid || day.toISODate() !== value)
      throw new Error("invalid_job_date");
    return (end ? day.plus({ days: 1 }) : day).toJSDate();
  }
  // Preserve the existing explicit-instant contract for other clients.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    throw new Error("invalid_job_date");
  const instant = DateTime.fromISO(value, { setZone: true });
  if (!instant.isValid) throw new Error("invalid_job_date");
  return instant.toJSDate();
}
