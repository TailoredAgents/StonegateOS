export type SquareReturnResult = {
  ok?: boolean;
  status?:
    | "verified"
    | "pending_verification"
    | "canceled"
    | "failed"
    | "needs_review";
  attemptId?: string | null;
  errorCode?: string | null;
  retryable?: boolean;
};

const squareSetupErrors = new Set([
  "disabled",
  "illegal_location_id",
  "no_employee_logged_in",
  "not_logged_in",
  "user_id_mismatch",
  "user_not_activated",
  "user_not_active",
  "user_not_logged_in",
]);

export function shouldRedirectToSquareSetup(
  result: SquareReturnResult,
): boolean {
  if (result.retryable !== true) return false;
  return squareSetupErrors.has(result.errorCode?.trim().toLowerCase() ?? "");
}
