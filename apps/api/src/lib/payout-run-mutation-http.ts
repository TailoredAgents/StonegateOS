import { TeamMutationFailure } from "@/lib/team-mutation";

const PAYOUT_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function requirePayoutRunId(value: string | null | undefined): string {
  const payoutRunId = value?.trim() ?? "";
  if (!PAYOUT_RUN_ID_PATTERN.test(payoutRunId)) {
    throw new TeamMutationFailure(
      "invalid",
      "Select a valid payout run and try again.",
      { fieldErrors: { payoutRunId: "A valid payout-run ID is required." } },
    );
  }
  return payoutRunId;
}

export function normalizePayoutRunMutationError(
  error: unknown,
): TeamMutationFailure {
  if (error instanceof TeamMutationFailure) return error;

  const code = error instanceof Error ? error.message : "internal";
  if (code === "payout_run_not_found") {
    return new TeamMutationFailure("invalid", "The payout run was not found.", {
      status: 404,
    });
  }
  if (code === "adjustment_not_found") {
    return new TeamMutationFailure(
      "invalid",
      "The reimbursement was not found.",
      { status: 404 },
    );
  }
  if (code === "adjustment_not_reimbursement") {
    return new TeamMutationFailure(
      "invalid",
      "The selected adjustment is not a reimbursement.",
    );
  }
  if (code === "payout_run_must_be_locked") {
    return new TeamMutationFailure(
      "conflict",
      "Lock the payout run before marking it paid.",
    );
  }
  if (code === "payout_run_already_paid") {
    return new TeamMutationFailure(
      "conflict",
      "This payout run is already paid and cannot be locked again.",
    );
  }
  if (code === "payout_run_not_editable") {
    return new TeamMutationFailure(
      "conflict",
      "Only draft payout runs can be edited.",
    );
  }
  if (code === "payout_run_expense_reconciliation_required") {
    return new TeamMutationFailure(
      "conflict",
      "The existing payroll expense does not match this payout run and requires review.",
    );
  }
  if (
    code === "payout_run_state_conflict" ||
    code === "payout_run_report_state_conflict"
  ) {
    return new TeamMutationFailure(
      "conflict",
      "The payout run changed while this action was running. Refresh and try again.",
      { retryable: true, retryAfter: "1" },
    );
  }
  if (
    code === "payout_run_create_failed" ||
    code === "payout_run_expense_create_failed"
  ) {
    return new TeamMutationFailure(
      "internal",
      "The payout operation could not be completed. Try again.",
      { retryable: true },
    );
  }

  return new TeamMutationFailure(
    "internal",
    "The payout operation could not be completed. Try again or contact support with the request ID.",
    { retryable: true },
  );
}
