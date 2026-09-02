import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  mutatePartnerAccountLifecycleAsStaff,
  recoverPartnerAdministratorAsTeamOwner,
  type PartnerAccountLifecycleAction,
} from "@/lib/partner-account-lifecycle-administration";
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
const LifecycleInputSchema = z
  .object({
    reason: z.string().trim().min(20).max(1_000),
    confirmation: z.string().min(1).max(80),
  })
  .strict();
const RecoveryInputSchema = LifecycleInputSchema.extend({
  membershipId: z.string().uuid(),
}).strict();

const CONFIRMATIONS = {
  suspend: "SUSPEND PARTNER ACCOUNT",
  reactivate: "REACTIVATE PARTNER ACCOUNT",
  close: "CLOSE PARTNER ACCOUNT",
} as const satisfies Record<PartnerAccountLifecycleAction, string>;

type AccountRouteContext = { params: Promise<{ accountId?: string }> };

function accountIdFrom(raw: string | undefined): string | null {
  const accountId = raw?.trim().toLowerCase() ?? "";
  return UUID_PATTERN.test(accountId) ? accountId : null;
}

async function readInput(request: NextRequest): Promise<unknown> {
  return readBoundedJsonRequest(request, {
    maximumBytes: 8 * 1_024,
    deadlineMs: 10_000,
    rejectDuplicateObjectKeys: true,
  });
}

async function settleClaimFailure(
  claim: TeamMutationIdempotencyClaim | null,
  mutation: TeamMutationContext,
  error: unknown,
): Promise<void> {
  if (!claim) return;
  try {
    await settleTeamMutationIdempotencyFailure(
      getDb(),
      mutation,
      claim,
      error,
    );
  } catch (settlementError) {
    console.error("[partner-management] account_mutation_settlement_failed", {
      correlationId: mutation.correlationId,
      errorName:
        settlementError instanceof Error
          ? settlementError.name
          : "UnknownError",
    });
  }
}

export async function handlePartnerAccountLifecycleMutation(input: {
  request: NextRequest;
  context: AccountRouteContext;
  mutation: TeamMutationContext;
  action: PartnerAccountLifecycleAction;
}): Promise<Response> {
  const { accountId: rawAccountId } = await input.context.params;
  const accountId = accountIdFrom(rawAccountId);
  if (!accountId) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner account.",
      { correlationId: input.mutation.correlationId },
    );
  }
  if (
    !input.mutation.expectedVersion ||
    input.mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest account lifecycle version is required.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: { version: "Refresh the company before continuing." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readInput(input.request);
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
  const parsed = LifecycleInputSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.confirmation !== CONFIRMATIONS[input.action]
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a durable reason and type the exact account confirmation.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: {
          reason: "Explain the decision in at least 20 characters.",
          confirmation: `Enter ${CONFIRMATIONS[input.action]} exactly.`,
        },
      },
    );
  }
  const actorId = input.mutation.actor.id;
  if (!actorId || !UUID_PATTERN.test(actorId)) {
    return teamMutationErrorResponse(
      "forbidden",
      "A verified Team member is required.",
      { correlationId: input.mutation.correlationId },
    );
  }

  const database = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const route = `POST /api/admin/partner-management/v1/accounts/:accountId/${input.action}`;
    const claimed = await claimTeamMutationIdempotency(
      database,
      input.mutation,
      {
        route,
        entityType: "partner_account",
        entityId: accountId,
        payload: parsed.data,
      },
    );
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await database.transaction(async (tx) => {
      const changed = await mutatePartnerAccountLifecycleAsStaff(tx, {
        partnerAccountId: accountId,
        action: input.action,
        expectedVersion: input.mutation.expectedVersion!,
        reason: parsed.data.reason,
        changedByTeamMemberId: actorId,
      });
      const audit = await input.mutation.audit.insertSuccess(tx, {
        entityType: "partner_account",
        entityId: accountId,
        before: changed.before,
        after: changed.after,
        metadata: {
          reason: parsed.data.reason,
          scope: "partner_account_lifecycle",
          sessionsRevoked: changed.sessionsRevoked,
          authTransactionsRevoked: changed.authTransactionsRevoked,
          authChallengesRevoked: changed.authChallengesRevoked,
          invitationsRevoked: changed.invitationsRevoked,
          operationalAndFinancialRecordsPreserved: true,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        input.mutation,
        {
          partnerAccountId: accountId,
          status: changed.account.portalLifecycleStatus,
          portalAccessEnabled: changed.account.portalAccessEnabled,
          sessionsRevoked: changed.sessionsRevoked,
          authTransactionsRevoked: changed.authTransactionsRevoked,
          authChallengesRevoked: changed.authChallengesRevoked,
          invitationsRevoked: changed.invitationsRevoked,
          recordsPreserved: true,
          version: String(changed.account.portalLifecycleRevision),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account",
          entityId: accountId,
          version: String(changed.account.portalLifecycleRevision),
        },
      );
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
    await settleClaimFailure(claim, input.mutation, error);
    return teamMutationExceptionResponse(error, input.mutation);
  }
}

export async function handlePartnerAdministratorRecoveryMutation(input: {
  request: NextRequest;
  context: AccountRouteContext;
  mutation: TeamMutationContext;
}): Promise<Response> {
  const { accountId: rawAccountId } = await input.context.params;
  const accountId = accountIdFrom(rawAccountId);
  if (!accountId) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner account.",
      { correlationId: input.mutation.correlationId },
    );
  }
  if (
    !input.mutation.expectedVersion ||
    input.mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest membership version is required.",
      { correlationId: input.mutation.correlationId },
    );
  }

  let raw: unknown;
  try {
    raw = await readInput(input.request);
  } catch (error) {
    return teamMutationExceptionResponse(error, input.mutation);
  }
  const parsed = RecoveryInputSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.confirmation !== "RECOVER PARTNER ADMINISTRATOR"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose an eligible membership, provide a durable reason, and confirm recovery exactly.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: {
          membershipId: "Choose an active, reviewed, MFA-enrolled member.",
          reason: "Explain the recovery in at least 20 characters.",
          confirmation: "Enter RECOVER PARTNER ADMINISTRATOR exactly.",
        },
      },
    );
  }
  const actorId = input.mutation.actor.id;
  if (!actorId || !UUID_PATTERN.test(actorId)) {
    return teamMutationErrorResponse(
      "forbidden",
      "A verified Team Owner is required.",
      { correlationId: input.mutation.correlationId },
    );
  }

  const database = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(
      database,
      input.mutation,
      {
        route:
          "POST /api/admin/partner-management/v1/accounts/:accountId/recover-administrator",
        entityType: "partner_account_membership",
        entityId: parsed.data.membershipId,
        payload: parsed.data,
      },
    );
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await database.transaction(async (tx) => {
      const changed = await recoverPartnerAdministratorAsTeamOwner(tx, {
        partnerAccountId: accountId,
        membershipId: parsed.data.membershipId,
        expectedVersion: input.mutation.expectedVersion!,
        changedByTeamMemberId: actorId,
      });
      const audit = await input.mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_membership",
        entityId: changed.membershipId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: accountId,
          partnerUserId: changed.partnerUserId,
          reason: parsed.data.reason,
          scope: "lost_administrator_recovery",
          sessionsRevoked: changed.sessionsRevoked,
          explicitOwnerRecovery: true,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        input.mutation,
        {
          partnerAccountId: accountId,
          membershipId: changed.membershipId,
          partnerUserId: changed.partnerUserId,
          roleKey: changed.roleKey,
          accessLevel: changed.accessLevel,
          sessionsRevoked: changed.sessionsRevoked,
          securityVersion: changed.securityVersion,
          version: changed.version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_membership",
          entityId: changed.membershipId,
          version: changed.version,
        },
      );
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
    await settleClaimFailure(claim, input.mutation, error);
    return teamMutationExceptionResponse(error, input.mutation);
  }
}
