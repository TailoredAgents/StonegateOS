import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { disablePartnerIdentityAsTeamOwner } from "@/lib/partner-identity-security-administration";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const InputSchema = z
  .object({
    membershipSnapshot: z.string().regex(/^[0-9a-f]{64}$/u),
    reason: z.string().trim().min(20).max(1_000),
    confirmation: z.string().min(1).max(320),
  })
  .strict();

type RouteContext = { params: Promise<{ userId?: string }> };

export async function handleTeamOwnerPartnerIdentitySecurityMutation(input: {
  request: NextRequest;
  context: RouteContext;
  mutation: TeamMutationContext;
  action: "disable";
}): Promise<Response> {
  const { userId: rawUserId } = await input.context.params;
  const partnerUserId = rawUserId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(partnerUserId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner identity.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: { userId: "Refresh Partner administration." },
      },
    );
  }
  if (
    !input.mutation.expectedVersion ||
    input.mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest identity version is required.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: {
          version: "Refresh and review every affected membership.",
        },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(input.request, {
      maximumBytes: 6 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      input.mutation,
    );
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a detailed reason, the reviewed membership snapshot, and the exact confirmation.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: {
          reason: "Explain the security reason in at least 20 characters.",
          confirmation: "Use the exact confirmation shown in the workspace.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const route =
      "POST /api/admin/partner-management/v1/security/identities/:userId/disable";
    const claimed = await claimTeamMutationIdempotency(db, input.mutation, {
      route,
      entityType: "partner_user",
      entityId: partnerUserId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const changed = await disablePartnerIdentityAsTeamOwner(tx, {
        partnerUserId,
        expectedVersion: input.mutation.expectedVersion!,
        membershipSnapshot: parsed.data.membershipSnapshot,
        confirmation: parsed.data.confirmation,
      });
      const audit = await input.mutation.audit.insertSuccess(tx, {
        entityType: "partner_user",
        entityId: partnerUserId,
        before: changed.before,
        after: changed.after,
        metadata: {
          reason: parsed.data.reason,
          scope: "global_partner_identity",
          membershipCount: changed.membershipCount,
          membershipSnapshot: changed.membershipSnapshot,
          membershipsChanged: false,
          accountJobFinancialRecordsPreserved: true,
          sessionsRevoked: changed.sessionsRevoked,
          loginTokensRevoked: changed.loginTokensRevoked,
          authChallengesRevoked: changed.authChallengesRevoked,
        },
      });
      const data = {
        partnerUserId,
        status: changed.status,
        active: changed.active,
        securityVersion: changed.securityVersion,
        membershipCount: changed.membershipCount,
        membershipsChanged: changed.membershipsChanged,
        recordsPreserved: changed.recordsPreserved,
        sessionsRevoked: changed.sessionsRevoked,
        version: changed.version,
      };
      const mutationResult = teamMutationSuccessResult(input.mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "partner_user",
        entityId: partnerUserId,
        version: changed.version,
      });
      await completeTeamMutationIdempotency(
        tx,
        input.mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(
      result,
      200,
      input.mutation.correlationId,
      {
        "Cache-Control": "private, no-store",
        ETag: `"${String(result.receipt.version)}"`,
      },
    );
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          input.mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error(
          "[partner-management] identity_security_settlement_failed",
          {
            action: input.action,
            correlationId: input.mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, input.mutation);
  }
}
