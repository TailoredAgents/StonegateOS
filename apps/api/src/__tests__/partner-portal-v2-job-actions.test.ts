import {
  allowedPartnerJobActions,
  resolvePartnerJobActionAvailability,
} from "@/lib/partner-portal-v2-job-actions";
import type { PartnerCancellationDecision } from "@/lib/partner-portal-v2-cancellation";

function cancellation(
  action: PartnerCancellationDecision["action"],
  code = action ? "before_cutoff" : "review_pending",
): PartnerCancellationDecision {
  return {
    action,
    reason: { code: code as never, label: "Cancellation policy result." },
    deadlineAt: "2026-09-02T12:00:00.000Z",
    timezone: "America/New_York",
    cutoffMinutes: 1_440,
    directCancellationEnabled: true,
    lateCancellationDisposition: "staff_review",
    consequence: {
      code: "cancel_without_automatic_fee",
      label: "No fee is applied automatically.",
      automaticFeeMinor: null,
    },
    policySource: "launch_default",
    policyRevision: null,
  };
}

const fullCapabilities = {
  update: true,
  requestChange: true,
  editReferences: true,
  cancel: true,
  message: true,
  uploadMedia: true,
  shareProof: true,
  duplicate: true,
};

describe("partner job action availability", () => {
  it("allows only actions whose role, status, schedule, proof, and cancellation policy permit them", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: true,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation("cancel"),
    });

    expect(allowedPartnerJobActions(actions)).toEqual([
      "request_change",
      "reschedule",
      "edit_references",
      "cancel",
      "message",
      "upload_media",
      "create_proof_share",
      "duplicate",
    ]);
    expect(
      actions.find((entry) => entry.action === "request_cancellation_review"),
    ).toMatchObject({ allowed: false, reason: { code: "status_unavailable" } });
  });

  it("returns safe reasons for terminal, missing-schedule, missing-proof, and permission blocks", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "completed",
      appointmentStatus: "completed",
      hasPromisedWindow: false,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: {
        ...fullCapabilities,
        cancel: false,
        message: false,
        duplicate: false,
      },
      cancellation: cancellation(null, "job_terminal"),
    });

    expect(
      actions.find((entry) => entry.action === "reschedule"),
    ).toMatchObject({ allowed: false, reason: { code: "job_terminal" } });
    expect(actions.find((entry) => entry.action === "cancel")).toMatchObject({
      allowed: false,
      reason: { code: "permission_required" },
    });
    expect(actions.find((entry) => entry.action === "message")).toMatchObject({
      allowed: false,
      reason: { code: "permission_required" },
    });
    expect(
      actions.find((entry) => entry.action === "create_proof_share"),
    ).toMatchObject({
      allowed: false,
      reason: { code: "proof_unavailable" },
    });
  });

  it("exposes review as the only cancellation action after the account cutoff", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation(
        "request_cancellation_review",
        "cutoff_elapsed",
      ),
    });

    expect(actions.find((entry) => entry.action === "cancel")).toMatchObject({
      allowed: false,
      reason: { code: "cancellation_policy_review" },
    });
    expect(
      actions.find((entry) => entry.action === "request_cancellation_review"),
    ).toMatchObject({ allowed: true, reason: { code: "available" } });
    expect(
      actions.find((entry) => entry.action === "reschedule"),
    ).toMatchObject({
      allowed: true,
      reason: { code: "available_review_required" },
    });
  });

  it("does not claim rescheduling when the underlying appointment state is ineligible", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "in_progress",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation("request_cancellation_review"),
    });

    expect(
      actions.find((entry) => entry.action === "reschedule"),
    ).toMatchObject({ allowed: false, reason: { code: "status_unavailable" } });
  });

  it("blocks stale and conflicting reschedule workflows with explicit reasons", () => {
    const pending = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: true,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation("cancel"),
    });
    expect(
      pending.find((entry) => entry.action === "reschedule"),
    ).toMatchObject({
      allowed: false,
      reason: { code: "reschedule_review_pending" },
    });

    const stale = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: false,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation("cancel"),
    });
    expect(stale.find((entry) => entry.action === "reschedule")).toMatchObject({
      allowed: false,
      reason: { code: "revision_unavailable" },
    });
  });

  it("keeps job-change and commercial-reference capabilities separate", () => {
    const operations = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: {
        ...fullCapabilities,
        editReferences: false,
      },
      cancellation: cancellation("cancel"),
    });
    expect(
      operations.find((entry) => entry.action === "request_change"),
    ).toMatchObject({
      allowed: true,
      reason: { code: "available_review_required" },
    });
    expect(
      operations.find((entry) => entry.action === "edit_references"),
    ).toMatchObject({
      allowed: false,
      reason: { code: "permission_required" },
    });

    const billing = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: {
        ...fullCapabilities,
        update: false,
        requestChange: false,
      },
      cancellation: cancellation(null, "permission_required"),
    });
    expect(
      billing.find((entry) => entry.action === "request_change"),
    ).toMatchObject({ allowed: false });
    expect(
      billing.find((entry) => entry.action === "reschedule"),
    ).toMatchObject({ allowed: false });
    expect(
      billing.find((entry) => entry.action === "edit_references"),
    ).toMatchObject({ allowed: true });
  });

  it("prevents duplicate pending change requests with an explicit reason", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "confirmed",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: true,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation("cancel"),
    });
    expect(
      actions.find((entry) => entry.action === "request_change"),
    ).toMatchObject({
      allowed: false,
      reason: { code: "change_request_pending" },
    });
  });

  it("does not advertise changes when the underlying appointment is terminal", () => {
    const actions = resolvePartnerJobActionAvailability({
      status: "confirmed",
      appointmentStatus: "canceled",
      hasPromisedWindow: true,
      proofAvailable: false,
      revisionAvailable: true,
      changeRequestPending: false,
      rescheduleReviewPending: false,
      cancellationReviewPending: false,
      capabilities: fullCapabilities,
      cancellation: cancellation(null, "job_terminal"),
    });
    for (const action of ["request_change", "edit_references"] as const) {
      expect(actions.find((entry) => entry.action === action)).toMatchObject({
        allowed: false,
        reason: { code: "job_terminal" },
      });
    }
  });
});
