import { parsePartnerRequestDetails } from "@myst-os/sdk";

/** The structured request replaces this generated snapshot, never staff notes. */
export function visiblePartnerAppointmentNotes<T extends { body: string }>(
  notes: T[] | undefined,
  partnerRequest: unknown,
): T[] {
  const details = parsePartnerRequestDetails(partnerRequest);
  if (!details) return notes ?? [];
  return (notes ?? []).filter((note) => {
    const lines = note.body.split("\n");
    const requester = lines[2] ?? "";
    const reviewReasons = lines.at(-1) ?? "";
    if (!/^Requested by: [^\s@]+@[^\s@]+$/u.test(requester)) return true;
    if (lines[0] === "[partner-portal-v2-booking]") {
      const generatedBookingBody = [
        "[partner-portal-v2-booking]",
        `Partner account: ${details.accountId}`,
        requester,
        `Service: ${details.service.key ?? "unspecified"}`,
        details.addOns.length
          ? `Add-ons: ${details.addOns.map((addOn) => `${addOn.label} × ${addOn.quantity}`).join(", ")}`
          : null,
        details.description ? `Description: ${details.description}` : null,
        details.crewInstructions
          ? `Crew instructions: ${details.crewInstructions}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      if (note.body === generatedBookingBody) return false;
      return !(
        /^Review reasons: [a-z0-9_, ]+$/u.test(reviewReasons) &&
        note.body === `${generatedBookingBody}\n${reviewReasons}`
      );
    }
    if (!/^Review reasons: [a-z0-9_, ]+$/u.test(reviewReasons)) return true;
    const generatedBody = [
      "[partner-portal-v2-review-request]",
      `Partner account: ${details.accountId}`,
      requester,
      `Service: ${details.service.key ?? "unspecified"}`,
      `Preferred dates: ${details.scheduling.preferredWindows
        .map((window) => `${window.localDate} (${window.timeOfDay})`)
        .join(", ")}`,
      details.scheduling.assistancePreference !== "none"
        ? `Scheduling assistance: ${details.scheduling.assistancePreference}`
        : null,
      details.description ? `Description: ${details.description}` : null,
      details.crewInstructions
        ? `Crew instructions: ${details.crewInstructions}`
        : null,
      reviewReasons,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    // Any changed or extra text may be a staff update and must remain visible.
    return note.body !== generatedBody;
  });
}
