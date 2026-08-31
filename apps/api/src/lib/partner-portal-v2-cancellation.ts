import { DateTime } from "luxon";

export const DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES = 24 * 60;
export const DEFAULT_PARTNER_CANCELLATION_TIMEZONE = "America/New_York";

export type PartnerCancellationAction =
  | "cancel"
  | "request_cancellation_review"
  | null;

export type PartnerCancellationReasonCode =
  | "before_cutoff"
  | "request_not_confirmed"
  | "cutoff_elapsed"
  | "schedule_pending"
  | "service_in_progress"
  | "review_pending"
  | "job_terminal"
  | "permission_required"
  | "status_unavailable";

export type PartnerCancellationConsequenceCode =
  | "cancel_without_automatic_fee"
  | "staff_review_without_automatic_fee"
  | "review_pending_without_automatic_fee"
  | "no_action_available";

export type PartnerCancellationPolicy = Readonly<{
  /** Elapsed minutes before the promised arrival window at which review begins. */
  cutoffMinutes: number;
  timezone: string;
  automaticFeeMinor: null;
  source: "launch_default" | "configured";
}>;

export type PartnerCancellationDecision = Readonly<{
  action: PartnerCancellationAction;
  reason: Readonly<{
    code: PartnerCancellationReasonCode;
    label: string;
  }>;
  deadlineAt: string | null;
  timezone: string;
  cutoffMinutes: number;
  consequence: Readonly<{
    code: PartnerCancellationConsequenceCode;
    label: string;
    automaticFeeMinor: null;
  }>;
  policySource: PartnerCancellationPolicy["source"];
}>;

const DIRECTLY_CANCELABLE_UNCONFIRMED_STATUSES = new Set([
  "requested",
  "approval_needed",
  "under_review",
]);
const TERMINAL_STATUSES = new Set(["completed", "canceled", "declined"]);

function validDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validTimezone(value: string): boolean {
  return DateTime.local().setZone(value).isValid;
}

function validatePolicy(policy: PartnerCancellationPolicy): void {
  if (
    !Number.isSafeInteger(policy.cutoffMinutes) ||
    policy.cutoffMinutes < 0 ||
    policy.cutoffMinutes > 365 * 24 * 60 ||
    !validTimezone(policy.timezone) ||
    policy.automaticFeeMinor !== null ||
    !["launch_default", "configured"].includes(policy.source)
  ) {
    throw new TypeError("Invalid partner cancellation policy.");
  }
}

/**
 * Returns the current launch policy. The input remains explicit so persisted
 * account policy can replace this resolver without changing the evaluator or
 * public contract. No automatic fee is ever represented by this policy.
 */
export function resolvePartnerCancellationPolicy(input?: {
  timezone?: string | null;
  cutoffMinutes?: number | null;
}): PartnerCancellationPolicy {
  const requestedTimezone = input?.timezone?.trim() ?? "";
  const timezone = validTimezone(requestedTimezone)
    ? requestedTimezone
    : DEFAULT_PARTNER_CANCELLATION_TIMEZONE;
  const configuredCutoff = input?.cutoffMinutes;
  const hasConfiguredCutoff =
    Number.isSafeInteger(configuredCutoff) &&
    (configuredCutoff ?? -1) >= 0 &&
    (configuredCutoff ?? Number.POSITIVE_INFINITY) <= 365 * 24 * 60;
  return Object.freeze({
    cutoffMinutes: hasConfiguredCutoff
      ? (configuredCutoff as number)
      : DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES,
    timezone,
    automaticFeeMinor: null,
    source: hasConfiguredCutoff ? "configured" : "launch_default",
  });
}

function decision(input: {
  action: PartnerCancellationAction;
  reasonCode: PartnerCancellationReasonCode;
  reasonLabel: string;
  deadlineAt: Date | null;
  policy: PartnerCancellationPolicy;
  consequenceCode: PartnerCancellationConsequenceCode;
  consequenceLabel: string;
}): PartnerCancellationDecision {
  return Object.freeze({
    action: input.action,
    reason: Object.freeze({
      code: input.reasonCode,
      label: input.reasonLabel,
    }),
    deadlineAt: input.deadlineAt?.toISOString() ?? null,
    timezone: input.policy.timezone,
    cutoffMinutes: input.policy.cutoffMinutes,
    consequence: Object.freeze({
      code: input.consequenceCode,
      label: input.consequenceLabel,
      automaticFeeMinor: null,
    }),
    policySource: input.policy.source,
  });
}

/**
 * Evaluates cancellation from the public promised arrival window, never from
 * Stonegate's internal planned start. The cutoff uses elapsed minutes, so UTC
 * comparison remains correct across daylight-saving transitions while the DTO
 * carries an explicit display timezone.
 */
export function evaluatePartnerCancellation(input: {
  status: string;
  promisedArrivalStartAt: Date | null;
  now: Date;
  canCancel: boolean;
  reviewPending: boolean;
  policy: PartnerCancellationPolicy;
}): PartnerCancellationDecision {
  validatePolicy(input.policy);
  if (!validDate(input.now)) {
    throw new TypeError("Invalid cancellation evaluation time.");
  }
  const deadlineAt = validDate(input.promisedArrivalStartAt)
    ? DateTime.fromJSDate(input.promisedArrivalStartAt, { zone: "utc" })
        .minus({ minutes: input.policy.cutoffMinutes })
        .toJSDate()
    : null;

  if (!input.canCancel) {
    return decision({
      action: null,
      reasonCode: "permission_required",
      reasonLabel: "Your account role cannot cancel this job.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "no_action_available",
      consequenceLabel: "Ask an account scheduler or Stonegate for help.",
    });
  }
  if (input.reviewPending) {
    return decision({
      action: null,
      reasonCode: "review_pending",
      reasonLabel: "A cancellation request is already under staff review.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "review_pending_without_automatic_fee",
      consequenceLabel:
        "The job remains scheduled until Stonegate responds. No fee is applied automatically.",
    });
  }
  if (TERMINAL_STATUSES.has(input.status)) {
    return decision({
      action: null,
      reasonCode: "job_terminal",
      reasonLabel: "This job can no longer be canceled in the portal.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "no_action_available",
      consequenceLabel: "Contact Stonegate if the recorded status looks wrong.",
    });
  }
  if (DIRECTLY_CANCELABLE_UNCONFIRMED_STATUSES.has(input.status)) {
    return decision({
      action: "cancel",
      reasonCode: "request_not_confirmed",
      reasonLabel: "This request is not yet confirmed and can be canceled now.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "cancel_without_automatic_fee",
      consequenceLabel:
        "The request will be canceled. No fee is applied automatically.",
    });
  }
  if (input.status === "en_route" || input.status === "in_progress") {
    return decision({
      action: "request_cancellation_review",
      reasonCode: "service_in_progress",
      reasonLabel: "Service activity has started, so staff review is required.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "staff_review_without_automatic_fee",
      consequenceLabel:
        "Stonegate will review the request. The job remains scheduled and no fee is applied automatically.",
    });
  }
  if (input.status !== "confirmed") {
    return decision({
      action: null,
      reasonCode: "status_unavailable",
      reasonLabel: "Cancellation is not available for the current job status.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "no_action_available",
      consequenceLabel: "Contact Stonegate for help with this job.",
    });
  }
  if (!deadlineAt) {
    return decision({
      action: "request_cancellation_review",
      reasonCode: "schedule_pending",
      reasonLabel:
        "The confirmed arrival window is unavailable, so staff review is required.",
      deadlineAt: null,
      policy: input.policy,
      consequenceCode: "staff_review_without_automatic_fee",
      consequenceLabel:
        "Stonegate will review the request. The job remains scheduled and no fee is applied automatically.",
    });
  }
  if (input.now.getTime() < deadlineAt.getTime()) {
    return decision({
      action: "cancel",
      reasonCode: "before_cutoff",
      reasonLabel: "This job is still before the cancellation cutoff.",
      deadlineAt,
      policy: input.policy,
      consequenceCode: "cancel_without_automatic_fee",
      consequenceLabel:
        "The job will be canceled. No fee is applied automatically.",
    });
  }
  return decision({
    action: "request_cancellation_review",
    reasonCode: "cutoff_elapsed",
    reasonLabel:
      "The cancellation cutoff has passed, so staff review is required.",
    deadlineAt,
    policy: input.policy,
    consequenceCode: "staff_review_without_automatic_fee",
    consequenceLabel:
      "Stonegate will review the request. The job remains scheduled and no fee is applied automatically.",
  });
}
