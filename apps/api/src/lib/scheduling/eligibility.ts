import { SchedulingDomainError } from "./errors";

export const SCHEDULING_REVIEW_REASON_CODES = [
  "account_approval_required",
  "missing_service_profile",
  "service_requires_review",
  "scope_incomplete",
  "scope_requires_review",
  "non_standard_job",
  "restricted_item",
  "oversized_scope",
  "access_requires_review",
  "media_required",
  "media_requires_review",
  "rate_not_configured",
  "property_requires_review",
  "service_area_requires_review",
  "schedule_policy_unconfigured",
  "calendar_unconfigured",
  "calendar_stale",
  "availability_unverified",
  "manual_review_required",
] as const;

export type SchedulingReviewReasonCode =
  (typeof SCHEDULING_REVIEW_REASON_CODES)[number];

const REVIEW_REASON_SET = new Set<string>(SCHEDULING_REVIEW_REASON_CODES);

export type CapacityReservationEvidence =
  | Readonly<{ kind: "active_hold"; expiresAt: Date }>
  | Readonly<{ kind: "atomic_capacity_check" }>
  | Readonly<{ kind: "none" }>;

export type InstantConfirmBlocker =
  | Readonly<{
      kind: "review_reason";
      reason: SchedulingReviewReasonCode;
    }>
  | Readonly<{ kind: "policy_disabled" }>
  | Readonly<{ kind: "service_disabled" }>
  | Readonly<{ kind: "capacity_reservation_missing" }>
  | Readonly<{ kind: "capacity_hold_expired" }>;

export type InstantConfirmEligibility = Readonly<{
  eligible: boolean;
  appointmentStatus: "confirmed" | "requested";
  reviewReasons: readonly SchedulingReviewReasonCode[];
  blockers: readonly InstantConfirmBlocker[];
}>;

export function isSchedulingReviewReasonCode(
  value: unknown,
): value is SchedulingReviewReasonCode {
  return typeof value === "string" && REVIEW_REASON_SET.has(value);
}

export function normalizeSchedulingReviewReasons(
  values: readonly unknown[],
): readonly SchedulingReviewReasonCode[] {
  const reasons = new Set<SchedulingReviewReasonCode>();
  for (const value of values) {
    if (value == null || value === "") continue;
    if (!isSchedulingReviewReasonCode(value)) {
      throw new SchedulingDomainError(
        "invalid_demand",
        "A scheduling review requirement is invalid.",
      );
    }
    reasons.add(value);
  }
  return Object.freeze(
    SCHEDULING_REVIEW_REASON_CODES.filter((reason) => reasons.has(reason)),
  );
}

/**
 * Instant confirmation requires both business eligibility and durable capacity
 * evidence. Any review reason routes the booking to requested/manual review.
 */
export function evaluateInstantConfirmEligibility(input: {
  policyAllowsInstantConfirmation: boolean;
  demandAllowsInstantConfirmation: boolean;
  capacityReservation: CapacityReservationEvidence;
  reviewReasons?: readonly unknown[];
  now?: Date;
}): InstantConfirmEligibility {
  if (
    typeof input.policyAllowsInstantConfirmation !== "boolean" ||
    typeof input.demandAllowsInstantConfirmation !== "boolean"
  ) {
    throw new SchedulingDomainError(
      "invalid_demand",
      "The instant-confirm configuration is invalid.",
    );
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new SchedulingDomainError(
      "invalid_interval",
      "The instant-confirm evaluation time is invalid.",
    );
  }
  const reviewReasons = normalizeSchedulingReviewReasons(
    input.reviewReasons ?? [],
  );
  const blockers: InstantConfirmBlocker[] = reviewReasons.map((reason) =>
    Object.freeze({ kind: "review_reason" as const, reason }),
  );
  if (!input.policyAllowsInstantConfirmation) {
    blockers.push(Object.freeze({ kind: "policy_disabled" }));
  }
  if (!input.demandAllowsInstantConfirmation) {
    blockers.push(Object.freeze({ kind: "service_disabled" }));
  }

  switch (input.capacityReservation?.kind) {
    case "none":
      blockers.push(Object.freeze({ kind: "capacity_reservation_missing" }));
      break;
    case "active_hold": {
      const expiresAt = input.capacityReservation.expiresAt;
      if (
        !(expiresAt instanceof Date) ||
        !Number.isFinite(expiresAt.getTime())
      ) {
        throw new SchedulingDomainError(
          "invalid_interval",
          "The scheduling hold expiry is invalid.",
        );
      }
      if (expiresAt.getTime() <= now.getTime()) {
        blockers.push(Object.freeze({ kind: "capacity_hold_expired" }));
      }
      break;
    }
    case "atomic_capacity_check":
      break;
    default:
      throw new SchedulingDomainError(
        "invalid_capacity",
        "The scheduling capacity reservation is invalid.",
      );
  }

  const frozenBlockers = Object.freeze(blockers);
  const eligible = frozenBlockers.length === 0;
  return Object.freeze({
    eligible,
    appointmentStatus: eligible ? "confirmed" : "requested",
    reviewReasons,
    blockers: frozenBlockers,
  });
}

export function assertInstantConfirmationEligible(
  eligibility: InstantConfirmEligibility,
): void {
  if (eligibility.eligible) return;
  throw new SchedulingDomainError(
    "review_required",
    "This booking needs review before it can be confirmed.",
  );
}
