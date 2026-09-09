import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  decidePartnerRescheduleRequest,
  PartnerPortalSchedulingError,
} from "@/lib/partner-portal-v2-scheduling";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";

const Decision = z
  .object({
    decision: z.enum(["accepted", "declined"]),
    reason: z.string().trim().min(12).max(1000),
    startAt: z.string().datetime({ offset: true }).optional(),
    selectedResourceIds: z.array(z.string().uuid()).max(60).optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.read", "appointments.update"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "partner_reschedule_request.decided",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const requestId = z
      .string()
      .uuid()
      .parse((await context.params).requestId);
    const body = Decision.parse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 4096,
        rejectDuplicateObjectKeys: true,
      }),
    );
    if (
      !mutation.expectedVersion ||
      !Number.isFinite(Date.parse(mutation.expectedVersion))
    )
      throw new TeamMutationFailure(
        "invalid",
        "Refresh this request before deciding. Its current revision is required.",
      );
    if (body.decision === "accepted" && !body.startAt)
      throw new TeamMutationFailure(
        "invalid",
        "Choose an available start time before approving.",
      );
    if (
      body.decision === "declined" &&
      (body.startAt || body.selectedResourceIds?.length)
    )
      throw new TeamMutationFailure(
        "invalid",
        "A declined request cannot change the schedule.",
      );
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/reschedule-requests/:requestId/decision",
      entityType: "partner_reschedule_request",
      entityId: requestId,
      payload: body,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const decided = await decidePartnerRescheduleRequest(tx, {
        requestId,
        decision: body.decision,
        reason: body.reason,
        startAt: body.startAt ? new Date(body.startAt) : null,
        expectedVersion: mutation.expectedVersion!,
        teamMemberId: mutation.actor.id!,
        correlationId: mutation.correlationId,
        selectedResourceIds: body.selectedResourceIds,
      });
      const committedAt = new Date(decided.updatedAt);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_reschedule_request",
        entityId: requestId,
        after: decided,
        metadata: {
          reason: body.reason,
          partnerAccountId: decided.accountId,
          partnerBookingId: decided.jobId,
        },
        committedAt,
      });
      const response = teamMutationSuccessResult(mutation, decided, {
        auditEventId: audit.auditEventId,
        committedAt: committedAt.toISOString(),
        entityType: "partner_reschedule_request",
        entityId: requestId,
        version: decided.updatedAt,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
        committedAt,
      );
      return response;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
      ETag: `"${result.receipt.version}"`,
    });
  } catch (caught) {
    const error =
      caught instanceof PartnerPortalSchedulingError
        ? new TeamMutationFailure(
            caught.status === 409 || caught.status === 412
              ? "conflict"
              : "invalid",
            caught.message,
            { status: caught.status, fieldErrors: caught.fieldErrors },
          )
        : caught instanceof z.ZodError
          ? new TeamMutationFailure(
              "invalid",
              "Provide a valid decision, time, and reason.",
            )
          : caught;
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(error, mutation);
  }
}
