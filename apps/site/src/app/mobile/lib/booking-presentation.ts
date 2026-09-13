export type MobilePartnerAffiliation = {
  accountId: string | null;
  bookingId: string | null;
  displayName: string | null;
  basis: "partner_booking" | "appointment_account" | "contact_partner";
};

const serviceLabels: Record<string, string> = {
  junk_removal: "Junk Removal",
  demolition: "Demo",
  moving: "Moving",
  land_clearing: "Land Clearing",
  rental_dumpster: "Dumpster Rental",
};

export function mobileServiceCategory(event: {
  source?: string;
  serviceCategoryLabel?: string | null;
  bookingDetails?: { serviceType?: string | null } | null;
}): string | null {
  if (event.source === "google") return null;
  const saved = event.bookingDetails?.serviceType;
  return (
    (saved && serviceLabels[saved]) ||
    event.serviceCategoryLabel?.trim() ||
    "Job"
  );
}

export function mobileBookingHref(
  screen: "myday" | "calendar",
  date: string,
  appointmentId?: string | null,
): string {
  const params = new URLSearchParams({ screen });
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) params.set("date", date);
  if (appointmentId) params.set("jobId", appointmentId);
  return `/mobile?${params.toString()}`;
}

/** Only restore a booking view, never an arbitrary redirect supplied in a URL. */
export function readMobileBookingReturn(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/mobile?")) return null;
  try {
    const url = new URL(value, "https://mobile.invalid");
    if (url.origin !== "https://mobile.invalid" || url.pathname !== "/mobile")
      return null;
    const screen = url.searchParams.get("screen");
    const jobId = url.searchParams.get("jobId");
    const date = url.searchParams.get("date") ?? "";
    if (
      (screen !== "myday" && screen !== "calendar") ||
      !jobId ||
      !/^[a-zA-Z0-9:_-]{1,150}$/u.test(jobId)
    )
      return null;
    return mobileBookingHref(screen, date, jobId);
  } catch {
    return null;
  }
}
