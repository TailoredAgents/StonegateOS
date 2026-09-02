import { DateTime } from "luxon";

export const DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES = 24 * 60;
export const DEFAULT_PARTNER_CANCELLATION_TIMEZONE = "America/New_York";
export const MAXIMUM_PARTNER_CANCELLATION_NOTICE_MINUTES = 365 * 24 * 60;

export type PartnerAccountCancellationPolicyValues = Readonly<{
  minimumNoticeMinutes: number;
  directCancellationEnabled: boolean;
  lateCancellationDisposition: "staff_review";
  automaticFeeMinor: null;
}>;

export type GlobalPartnerCancellationPolicyValues =
  PartnerAccountCancellationPolicyValues;

export const DEFAULT_GLOBAL_PARTNER_CANCELLATION_POLICY: GlobalPartnerCancellationPolicyValues =
  Object.freeze({
    minimumNoticeMinutes: DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES,
    directCancellationEnabled: true,
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
  });

export const DEFAULT_PARTNER_ACCOUNT_CANCELLATION_POLICY: PartnerAccountCancellationPolicyValues =
  Object.freeze({
    minimumNoticeMinutes: DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES,
    directCancellationEnabled: true,
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
  });

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
  | "policy_review_required"
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
  directCancellationEnabled: boolean;
  lateCancellationDisposition: "staff_review";
  automaticFeeMinor: null;
  source: "launch_default" | "configured" | "unconfigured";
  revision: number | null;
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
  directCancellationEnabled: boolean;
  lateCancellationDisposition: "staff_review";
  consequence: Readonly<{
    code: PartnerCancellationConsequenceCode;
    label: string;
    automaticFeeMinor: null;
  }>;
  policySource: PartnerCancellationPolicy["source"];
  policyRevision: number | null;
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
    policy.cutoffMinutes > MAXIMUM_PARTNER_CANCELLATION_NOTICE_MINUTES ||
    !validTimezone(policy.timezone) ||
    typeof policy.directCancellationEnabled !== "boolean" ||
    policy.lateCancellationDisposition !== "staff_review" ||
    policy.automaticFeeMinor !== null ||
    !["launch_default", "configured", "unconfigured"].includes(policy.source) ||
    (policy.source === "configured"
      ? !Number.isSafeInteger(policy.revision) || (policy.revision ?? 0) < 1
      : policy.revision !== null)
  ) {
    throw new TypeError("Invalid partner cancellation policy.");
  }
}

export function validatePartnerAccountCancellationPolicy(
  policy: PartnerAccountCancellationPolicyValues,
): PartnerAccountCancellationPolicyValues {
  if (
    !policy ||
    !Number.isSafeInteger(policy.minimumNoticeMinutes) ||
    policy.minimumNoticeMinutes < DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES ||
    policy.minimumNoticeMinutes > MAXIMUM_PARTNER_CANCELLATION_NOTICE_MINUTES ||
    typeof policy.directCancellationEnabled !== "boolean" ||
    policy.lateCancellationDisposition !== "staff_review" ||
    policy.automaticFeeMinor !== null
  ) {
    throw new TypeError("Invalid partner account cancellation policy.");
  }
  return Object.freeze({ ...policy });
}

export function resolvePersistedPartnerAccountCancellationPolicy(
  row: Readonly<{
    minimumNoticeMinutes: number;
    directCancellationEnabled: boolean;
    lateCancellationDisposition: string;
    automaticFeeMinor: number | null;
    revision: number;
  }> | null,
): (PartnerAccountCancellationPolicyValues & { revision: number }) | null {
  if (
    !row ||
    row.lateCancellationDisposition !== "staff_review" ||
    row.automaticFeeMinor !== null ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  ) {
    return null;
  }
  try {
    return Object.freeze({
      ...validatePartnerAccountCancellationPolicy({
        minimumNoticeMinutes: row.minimumNoticeMinutes,
        directCancellationEnabled: row.directCancellationEnabled,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: null,
      }),
      revision: row.revision,
    });
  } catch {
    return null;
  }
}

/**
 * Account cancellation policy can only be stricter than Stonegate policy:
 * notice uses max precedence and direct cancellation uses logical AND. The
 * launch contract has no automatic fee and routes every late request to staff.
 */
export function narrowGlobalPartnerCancellationPolicy(input: {
  global: GlobalPartnerCancellationPolicyValues;
  account: PartnerAccountCancellationPolicyValues;
}): PartnerAccountCancellationPolicyValues {
  const global = validatePartnerAccountCancellationPolicy(input.global);
  const account = validatePartnerAccountCancellationPolicy(input.account);
  return Object.freeze({
    minimumNoticeMinutes: Math.max(
      global.minimumNoticeMinutes,
      account.minimumNoticeMinutes,
    ),
    directCancellationEnabled:
      global.directCancellationEnabled && account.directCancellationEnabled,
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
  });
}

/**
 * Returns the current launch policy. The input remains explicit so persisted
 * account policy can replace this resolver without changing the evaluator or
 * public contract. No automatic fee is ever represented by this policy.
 */
export function resolvePartnerCancellationPolicy(input?: {
  timezone?: string | null;
  globalPolicy?: GlobalPartnerCancellationPolicyValues;
  accountPolicy?:
    | (PartnerAccountCancellationPolicyValues & {
        revision: number;
      })
    | null;
}): PartnerCancellationPolicy {
  const requestedTimezone = input?.timezone?.trim() ?? "";
  const timezone = validTimezone(requestedTimezone)
    ? requestedTimezone
    : DEFAULT_PARTNER_CANCELLATION_TIMEZONE;
  const globalPolicy =
    input?.globalPolicy ?? DEFAULT_GLOBAL_PARTNER_CANCELLATION_POLICY;
  const hasAccountInput =
    input !== undefined &&
    Object.prototype.hasOwnProperty.call(input, "accountPolicy");
  const accountPolicy = hasAccountInput
    ? (input?.accountPolicy ?? {
        ...DEFAULT_PARTNER_ACCOUNT_CANCELLATION_POLICY,
        directCancellationEnabled: false,
        revision: 0,
      })
    : { ...DEFAULT_PARTNER_ACCOUNT_CANCELLATION_POLICY, revision: 0 };
  const effective = narrowGlobalPartnerCancellationPolicy({
    global: globalPolicy,
    account: accountPolicy,
  });
  const configured = hasAccountInput && input?.accountPolicy !== null;
  return Object.freeze({
    cutoffMinutes: effective.minimumNoticeMinutes,
    timezone,
    directCancellationEnabled: effective.directCancellationEnabled,
    lateCancellationDisposition: effective.lateCancellationDisposition,
    automaticFeeMinor: null,
    source: configured
      ? "configured"
      : hasAccountInput
        ? "unconfigured"
        : "launch_default",
    revision: configured ? (input?.accountPolicy?.revision ?? null) : null,
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
    directCancellationEnabled: input.policy.directCancellationEnabled,
    lateCancellationDisposition: input.policy.lateCancellationDisposition,
    consequence: Object.freeze({
      code: input.consequenceCode,
      label: input.consequenceLabel,
      automaticFeeMinor: null,
    }),
    policySource: input.policy.source,
    policyRevision: input.policy.revision,
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
  if (!input.policy.directCancellationEnabled) {
    return decision({
      action: "request_cancellation_review",
      reasonCode: "policy_review_required",
      reasonLabel:
        "This account requires staff review for confirmed-job cancellations.",
      deadlineAt,
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
