import type { MutationResult } from "@myst-os/sdk";
import type { BoundedJsonRequestError } from "@/lib/bounded-json-request";
import {
  completeTeamMutationIdempotency,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationResultResponse,
} from "@/lib/team-mutation";

export const APPOINTMENT_PAYMENT_REQUEST_MAXIMUM_BYTES = 2 * 1024;
export const APPOINTMENT_PAYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AppointmentPaymentMutationFailure = Extract<
  MutationResult<never>,
  { ok: false }
> & {
  current?: { version: string };
  attemptId?: string;
};

export function requireExactAppointmentPaymentVersion(
  expectedVersion: string | null,
): string {
  if (
    expectedVersion === null ||
    expectedVersion === "*" ||
    !Number.isFinite(Date.parse(expectedVersion)) ||
    new Date(expectedVersion).toISOString() !== expectedVersion
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current appointment version is required before collecting payment.",
      {
        fieldErrors: { version: "Refresh the appointment and try again." },
      },
    );
  }
  return expectedVersion;
}

export function boundedAppointmentPaymentRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  if (error.code === "body_timeout") {
    return new TeamMutationFailure("timeout", error.message, {
      status: error.status,
      retryable: true,
    });
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
  });
}

export function appointmentPaymentMutationResponse<T>(
  result: MutationResult<T>,
  status: number,
  correlationId: string,
  options: { replayed?: boolean; retryAfter?: string | null } = {},
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
  });
  if (options.replayed) headers.set("idempotency-replayed", "true");
  if (options.retryAfter) headers.set("Retry-After", options.retryAfter);
  return teamMutationResultResponse(result, status, correlationId, headers);
}

export async function completeAppointmentPaymentFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  appointmentId: string,
  result: AppointmentPaymentMutationFailure,
  status: number,
  metadata: Record<string, unknown> = {},
): Promise<{
  result: AppointmentPaymentMutationFailure;
  status: number;
}> {
  if (!mutation.audit.insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The financial failure audit boundary is unavailable. No changes were saved.",
      { retryable: true },
    );
  }
  await mutation.audit.insertFailure(tx, {
    outcome: result.code === "forbidden" ? "denied" : "failed",
    entityType: "appointment",
    entityId: appointmentId,
    code: result.code,
    metadata: { ...metadata, responseStatus: status },
  });
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return { result, status };
}
