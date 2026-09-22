/**
 * Use one explicit timezone and separator during server rendering and hydration.
 * Combined Intl date/time styles insert different punctuation in Safari's ICU.
 */
export function formatPartnerDate(
  date: Date,
  timezone = "America/New_York",
): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(date);
}

export function formatPartnerDateTime(
  date: Date,
  timezone = "America/New_York",
): string {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  }).format(date);
  return `${formatPartnerDate(date, timezone)}, ${time}`;
}
