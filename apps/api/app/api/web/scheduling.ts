import { DateTime } from "luxon";
import { availabilityWindows } from "@myst-os/pricing";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";

export const APPOINTMENT_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ??
  process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
  "America/New_York";

export const DEFAULT_APPOINTMENT_DURATION_MIN = 60;
export const DEFAULT_TRAVEL_BUFFER_MIN = 30;

export const SITE_URL = resolvePublicSiteBaseUrl({ devFallbackLocalhost: true });

function getAvailabilityWindow(windowId: string | undefined | null) {
  if (!windowId) {
    return null;
  }
  return availabilityWindows.find((window) => window.id === windowId) ?? null;
}

export function resolveAppointmentTiming(
  preferredDate?: string | null,
  timeWindowId?: string | null
): { startAt: Date | null; durationMinutes: number } {
  const window = getAvailabilityWindow(timeWindowId ?? undefined);
  const defaultDuration =
    window && window.endHour > window.startHour
      ? (window.endHour - window.startHour) * 60
      : DEFAULT_APPOINTMENT_DURATION_MIN;

  if (!preferredDate) {
    return { startAt: null, durationMinutes: defaultDuration };
  }

  const base = DateTime.fromISO(preferredDate, { zone: APPOINTMENT_TIME_ZONE });
  if (!base.isValid) {
    return { startAt: null, durationMinutes: defaultDuration };
  }

  const startHour = window?.startHour ?? 9;
  const start = base.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 }).toUTC();
  return { startAt: start.toJSDate(), durationMinutes: defaultDuration };
}

export function buildRescheduleUrl(appointmentId: string, token: string): string | null {
  if (!SITE_URL) return null;
  const url = new URL("/schedule", SITE_URL);
  url.searchParams.set("appointmentId", appointmentId);
  url.searchParams.set("token", token);
  return url.toString();
}
