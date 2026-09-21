/** A requested local date must not move when the staff browser uses another timezone. */
export function requestedPartnerDate(localDate: string): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date)
    : localDate;
}

export function requestedPartnerWindow(window: {
  localDate: string;
  timeOfDay: string;
}): string {
  const day = requestedPartnerDate(window.localDate);
  const time =
    window.timeOfDay === "anytime"
      ? "Any time"
      : window.timeOfDay
          .replaceAll("_", " ")
          .replace(/^./u, (first) => first.toUpperCase());
  return `${day} · ${time}`;
}

const REVIEW_CHECKS: Record<string, string> = {
  account_approval_required: "The client must approve this work.",
  missing_service_profile: "Check the service setup for this company.",
  service_requires_review: "Review the service and agree on the work.",
  scope_incomplete: "Ask the client for the missing work details.",
  scope_requires_review: "Review the requested work.",
  non_standard_job: "Check the requirements for this nonstandard job.",
  restricted_item: "Check the reported restricted items.",
  oversized_scope: "Check crew and equipment needs for this larger job.",
  access_requires_review: "Check the access instructions.",
  media_required: "Request the photos needed to assess this job.",
  media_requires_review: "Review the client’s photos.",
  rate_not_configured: "Agree on pricing before confirming.",
  property_requires_review: "Check the service location.",
  service_area_requires_review:
    "Check that this address is in the service area.",
  schedule_policy_unconfigured: "Check this company’s scheduling settings.",
  resource_assignment_unconfigured: "Check crew and vehicle availability.",
  calendar_unconfigured: "Set up the service calendar.",
  calendar_stale: "Refresh the calendar before choosing a time.",
  schedule_change_policy_review_required:
    "Review the requested schedule change.",
};

export function partnerReviewCheck(reason: string): string {
  return REVIEW_CHECKS[reason] ?? reason.replaceAll("_", " ");
}
