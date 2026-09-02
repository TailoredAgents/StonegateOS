import type {
  PartnerCancellationAction,
  PartnerCancellationDecision,
} from "@/lib/partner-portal-v2-cancellation";

export const PARTNER_JOB_ACTION_KEYS = [
  "request_change",
  "reschedule",
  "edit_references",
  "cancel",
  "request_cancellation_review",
  "message",
  "upload_media",
  "create_proof_share",
  "duplicate",
] as const;

export type PartnerJobActionKey = (typeof PARTNER_JOB_ACTION_KEYS)[number];

export type PartnerJobActionReasonCode =
  | "available"
  | "permission_required"
  | "job_terminal"
  | "status_unavailable"
  | "schedule_unavailable"
  | "revision_unavailable"
  | "feature_unavailable"
  | "change_request_pending"
  | "reschedule_review_pending"
  | "cancellation_review_pending"
  | "cancellation_policy_review"
  | "available_review_required"
  | "proof_unavailable";

export type PartnerJobActionAvailability = Readonly<{
  action: PartnerJobActionKey;
  allowed: boolean;
  reason: Readonly<{
    code: PartnerJobActionReasonCode;
    label: string;
  }>;
}>;

export type PartnerJobActionCapabilities = Readonly<{
  update: boolean;
  requestChange: boolean;
  editReferences: boolean;
  cancel: boolean;
  message: boolean;
  uploadMedia: boolean;
  shareProof: boolean;
  duplicate: boolean;
}>;

const TERMINAL_STATUSES = new Set(["completed", "canceled", "declined"]);
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "completed",
  "canceled",
  "no_show",
]);
const RESCHEDULABLE_PUBLIC_STATUSES = new Set([
  "requested",
  "approval_needed",
  "under_review",
  "confirmed",
]);
const RESCHEDULABLE_APPOINTMENT_STATUSES = new Set(["requested", "confirmed"]);

function availability(
  action: PartnerJobActionKey,
  allowed: boolean,
  code: PartnerJobActionReasonCode,
  label: string,
): PartnerJobActionAvailability {
  return Object.freeze({
    action,
    allowed,
    reason: Object.freeze({ code, label }),
  });
}

function permission(
  action: PartnerJobActionKey,
  label: string,
): PartnerJobActionAvailability {
  return availability(action, false, "permission_required", label);
}

function terminal(action: PartnerJobActionKey): PartnerJobActionAvailability {
  return availability(
    action,
    false,
    "job_terminal",
    "This action is unavailable because the job is closed.",
  );
}

function rescheduleAction(input: {
  status: string;
  appointmentStatus: string;
  hasPromisedWindow: boolean;
  canUpdate: boolean;
  revisionAvailable: boolean;
  rescheduleReviewPending: boolean;
  cancellationReviewPending: boolean;
  rescheduleRequiresReview: boolean;
}): PartnerJobActionAvailability {
  if (!input.canUpdate) {
    return permission(
      "reschedule",
      "Your account role does not allow changes to this job.",
    );
  }
  if (TERMINAL_STATUSES.has(input.status)) return terminal("reschedule");
  if (!input.revisionAvailable) {
    return availability(
      "reschedule",
      false,
      "revision_unavailable",
      "Refresh the job before changing its schedule.",
    );
  }
  if (input.cancellationReviewPending) {
    return availability(
      "reschedule",
      false,
      "cancellation_review_pending",
      "A cancellation request is under review, so the schedule cannot be changed.",
    );
  }
  if (input.rescheduleReviewPending) {
    return availability(
      "reschedule",
      false,
      "reschedule_review_pending",
      "A schedule-change request is already under review.",
    );
  }
  if (
    !RESCHEDULABLE_PUBLIC_STATUSES.has(input.status) ||
    !RESCHEDULABLE_APPOINTMENT_STATUSES.has(input.appointmentStatus)
  ) {
    return availability(
      "reschedule",
      false,
      "status_unavailable",
      "This job cannot be rescheduled at its current stage.",
    );
  }
  if (!input.hasPromisedWindow) {
    return availability(
      "reschedule",
      false,
      "schedule_unavailable",
      "A confirmed or requested arrival window is required before rescheduling.",
    );
  }
  if (input.rescheduleRequiresReview) {
    return availability(
      "reschedule",
      true,
      "available_review_required",
      "You can request a new window; the existing appointment stays in place until Stonegate reviews it.",
    );
  }
  return availability("reschedule", true, "available", "Available now.");
}

function requestChangeAction(input: {
  status: string;
  appointmentStatus: string;
  canRequestChange: boolean;
  revisionAvailable: boolean;
  changeRequestPending: boolean;
  cancellationReviewPending: boolean;
}): PartnerJobActionAvailability {
  if (!input.canRequestChange) {
    return permission(
      "request_change",
      "Your account role does not allow job change requests.",
    );
  }
  if (
    TERMINAL_STATUSES.has(input.status) ||
    TERMINAL_APPOINTMENT_STATUSES.has(input.appointmentStatus)
  ) {
    return terminal("request_change");
  }
  if (!input.revisionAvailable) {
    return availability(
      "request_change",
      false,
      "revision_unavailable",
      "Refresh the job before requesting a change.",
    );
  }
  if (input.cancellationReviewPending) {
    return availability(
      "request_change",
      false,
      "cancellation_review_pending",
      "A cancellation request is under review, so another job change cannot be requested.",
    );
  }
  if (input.changeRequestPending) {
    return availability(
      "request_change",
      false,
      "change_request_pending",
      "A job change request is already under review.",
    );
  }
  return availability(
    "request_change",
    true,
    "available_review_required",
    "You can request a change. The current job stays unchanged until Stonegate reviews it.",
  );
}

function editReferencesAction(input: {
  status: string;
  appointmentStatus: string;
  canEditReferences: boolean;
  revisionAvailable: boolean;
}): PartnerJobActionAvailability {
  if (!input.canEditReferences) {
    return permission(
      "edit_references",
      "Your account role does not allow commercial reference changes.",
    );
  }
  if (
    TERMINAL_STATUSES.has(input.status) ||
    TERMINAL_APPOINTMENT_STATUSES.has(input.appointmentStatus)
  ) {
    return terminal("edit_references");
  }
  if (!input.revisionAvailable) {
    return availability(
      "edit_references",
      false,
      "revision_unavailable",
      "Refresh the job before changing its references.",
    );
  }
  return availability(
    "edit_references",
    true,
    "available",
    "PO, cost center, and project reference can be updated now.",
  );
}

function cancellationActions(input: {
  canCancel: boolean;
  cancellation: PartnerCancellationDecision;
}): [PartnerJobActionAvailability, PartnerJobActionAvailability] {
  if (!input.canCancel) {
    const blocked = permission(
      "cancel",
      "Your account role cannot cancel this job.",
    );
    return [
      blocked,
      permission(
        "request_cancellation_review",
        "Your account role cannot request cancellation review.",
      ),
    ];
  }

  const selected = input.cancellation.action;
  if (selected === "cancel") {
    return [
      availability(
        "cancel",
        true,
        "available",
        input.cancellation.reason.label,
      ),
      availability(
        "request_cancellation_review",
        false,
        "status_unavailable",
        "Staff review is not required before this cancellation cutoff.",
      ),
    ];
  }
  if (selected === "request_cancellation_review") {
    return [
      availability(
        "cancel",
        false,
        "cancellation_policy_review",
        input.cancellation.reason.label,
      ),
      availability(
        "request_cancellation_review",
        true,
        "available",
        input.cancellation.reason.label,
      ),
    ];
  }
  const reviewPending = input.cancellation.reason.code === "review_pending";
  const code: PartnerJobActionReasonCode = reviewPending
    ? "cancellation_review_pending"
    : input.cancellation.reason.code === "job_terminal"
      ? "job_terminal"
      : "status_unavailable";
  return [
    availability("cancel", false, code, input.cancellation.reason.label),
    availability(
      "request_cancellation_review",
      false,
      code,
      input.cancellation.reason.label,
    ),
  ];
}

/**
 * Creates the safe, explainable public action policy for one job. The route
 * still exposes `allowedActions` for backwards compatibility, but clients can
 * use this complete projection to explain why an action is not currently
 * available instead of guessing from an omitted string.
 */
export function resolvePartnerJobActionAvailability(input: {
  status: string;
  appointmentStatus: string;
  hasPromisedWindow: boolean;
  proofAvailable: boolean;
  revisionAvailable: boolean;
  changeRequestPending: boolean;
  rescheduleReviewPending: boolean;
  cancellationReviewPending: boolean;
  capabilities: PartnerJobActionCapabilities;
  cancellation: PartnerCancellationDecision;
}): PartnerJobActionAvailability[] {
  const scheduleInput = {
    status: input.status,
    appointmentStatus: input.appointmentStatus,
    hasPromisedWindow: input.hasPromisedWindow,
    canUpdate: input.capabilities.update,
    revisionAvailable: input.revisionAvailable,
    rescheduleReviewPending: input.rescheduleReviewPending,
    cancellationReviewPending: input.cancellationReviewPending,
    rescheduleRequiresReview:
      input.cancellation.action === "request_cancellation_review",
  };
  const [cancel, requestCancellationReview] = cancellationActions({
    canCancel: input.capabilities.cancel,
    cancellation: input.cancellation,
  });
  const mediaClosed = ["canceled", "declined"].includes(input.status);

  return [
    requestChangeAction({
      status: input.status,
      appointmentStatus: input.appointmentStatus,
      canRequestChange: input.capabilities.requestChange,
      revisionAvailable: input.revisionAvailable,
      changeRequestPending: input.changeRequestPending,
      cancellationReviewPending: input.cancellationReviewPending,
    }),
    rescheduleAction(scheduleInput),
    editReferencesAction({
      status: input.status,
      appointmentStatus: input.appointmentStatus,
      canEditReferences: input.capabilities.editReferences,
      revisionAvailable: input.revisionAvailable,
    }),
    cancel,
    requestCancellationReview,
    input.capabilities.message
      ? availability("message", true, "available", "Available now.")
      : permission(
          "message",
          "Your account role does not allow sending job messages.",
        ),
    !input.capabilities.uploadMedia
      ? permission(
          "upload_media",
          "Your account role does not allow job uploads.",
        )
      : mediaClosed
        ? terminal("upload_media")
        : availability("upload_media", true, "available", "Available now."),
    !input.capabilities.shareProof
      ? permission(
          "create_proof_share",
          "Your account role does not allow proof sharing.",
        )
      : !input.proofAvailable
        ? availability(
            "create_proof_share",
            false,
            "proof_unavailable",
            "A completed proof package is required before it can be shared.",
          )
        : availability(
            "create_proof_share",
            true,
            "available",
            "Available now.",
          ),
    input.capabilities.duplicate
      ? availability("duplicate", true, "available", "Available now.")
      : permission(
          "duplicate",
          "Your account role does not allow creating a new job.",
        ),
  ];
}

export function allowedPartnerJobActions(
  actions: readonly PartnerJobActionAvailability[],
): PartnerJobActionKey[] {
  return actions.filter((entry) => entry.allowed).map((entry) => entry.action);
}

export function selectedPartnerCancellationAction(
  actions: readonly PartnerJobActionAvailability[],
): PartnerCancellationAction {
  if (actions.some((entry) => entry.action === "cancel" && entry.allowed)) {
    return "cancel";
  }
  if (
    actions.some(
      (entry) =>
        entry.action === "request_cancellation_review" && entry.allowed,
    )
  ) {
    return "request_cancellation_review";
  }
  return null;
}
