export type PartnerJobCalendarInput = Readonly<{
  jobId: string;
  serviceLabel: string;
  locationLabel: string;
  startAt: string;
  endAt: string;
  portalUrl: string;
  status: "confirmed" | "tentative";
  generatedAt?: Date;
}>;

export type PartnerJobCalendarFile = Readonly<{
  filename: string;
  content: string;
}>;

function escapeCalendarText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\r\n|\r|\n/gu, "\\n")
    .replace(/,/gu, "\\,")
    .replace(/;/gu, "\\;")
    .trim();
}

function calendarInstant(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("partner_job_calendar_instant_invalid");
  }
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

function safeReference(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,64}$/u.test(normalized)) {
    throw new TypeError("partner_job_calendar_reference_invalid");
  }
  return normalized;
}

export function createPartnerJobCalendarFile(
  input: PartnerJobCalendarInput,
): PartnerJobCalendarFile {
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    throw new TypeError("partner_job_calendar_window_invalid");
  }
  const jobId = safeReference(input.jobId);
  let portalUrl: URL;
  try {
    portalUrl = new URL(input.portalUrl);
  } catch {
    throw new TypeError("partner_job_calendar_url_invalid");
  }
  if (!["https:", "http:"].includes(portalUrl.protocol)) {
    throw new TypeError("partner_job_calendar_url_invalid");
  }
  portalUrl.search = "";
  portalUrl.hash = "";

  const tentative = input.status === "tentative";
  const summary = tentative
    ? `Tentative Stonegate ${input.serviceLabel} arrival window`
    : `Stonegate ${input.serviceLabel} arrival window`;
  const description = tentative
    ? `Requested window only—not yet confirmed. Check the Partner Portal for the current status: ${portalUrl.toString()}`
    : `Confirmed two-hour arrival window. Check the Partner Portal for current status and updates: ${portalUrl.toString()}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stonegate//Partner Portal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:partner-job-${jobId}@stonegate.local`,
    `DTSTAMP:${calendarInstant(input.generatedAt ?? new Date())}`,
    `DTSTART:${calendarInstant(start)}`,
    `DTEND:${calendarInstant(end)}`,
    `SUMMARY:${escapeCalendarText(summary)}`,
    `LOCATION:${escapeCalendarText(input.locationLabel)}`,
    `DESCRIPTION:${escapeCalendarText(description)}`,
    `STATUS:${tentative ? "TENTATIVE" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return Object.freeze({
    filename: `stonegate-job-${jobId.slice(0, 8)}.ics`,
    content: `${lines.join("\r\n")}\r\n`,
  });
}
