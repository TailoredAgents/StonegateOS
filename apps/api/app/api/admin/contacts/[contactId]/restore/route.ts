import type { NextRequest } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { contacts, getDb } from "@/db";
import { planContactRestore } from "@/lib/contact-retention";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.restore"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "contact.restored",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Route state is intentionally read only after the complete trust boundary.
  const { contactId } = await context.params;
  const normalizedContactId = contactId?.trim() ?? "";
  if (!isUuid(normalizedContactId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid contact ID is required before restoring a contact.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { contactId: "Select a valid contact." },
      },
    );
  }
  if (
    mutation.expectedVersion === null ||
    mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest contact version is required before restoration.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the recovery list and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/contacts/:contactId/restore",
      entityType: "contact",
      entityId: normalizedContactId,
      payload: { method: "POST" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const executableClaim = claimed.claim;
    claim = executableClaim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalizedContactId}, 0))`,
      );
      const [existing] = await tx
        .select({
          id: contacts.id,
          deletedAt: contacts.deletedAt,
          purgeEligibleAt: contacts.purgeEligibleAt,
          mergedIntoContactId: contacts.mergedIntoContactId,
          mergeRecoveryLedgerId: contacts.mergeRecoveryLedgerId,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, normalizedContactId))
        .for("update")
        .limit(1);

      if (!existing) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact no longer exists. Refresh the recovery list before continuing.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      if (existing.mergeRecoveryLedgerId || existing.mergedIntoContactId) {
        throw new TeamMutationFailure(
          "conflict",
          "This contact was consolidated by a merge and cannot use ordinary restore. Review its merge recovery assessment instead.",
        );
      }

      const restorePlan = planContactRestore(
        existing,
        new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
      );
      if (restorePlan.kind === "already_active") {
        throw new TeamMutationFailure(
          "conflict",
          "This contact is already active. Refresh the contact list before continuing.",
        );
      }

      const { restoredAt, previousDeletedAt } = restorePlan;
      const [restored] = await tx
        .update(contacts)
        .set({
          deletedAt: null,
          deletedBy: null,
          purgeEligibleAt: null,
          updatedAt: restoredAt,
        })
        .where(
          and(
            eq(contacts.id, normalizedContactId),
            isNotNull(contacts.deletedAt),
          ),
        )
        .returning({ id: contacts.id });
      if (!restored?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact changed while it was being restored. Refresh and try again.",
          { retryable: true },
        );
      }

      const version = restoredAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: restored.id,
        before: {
          deletedAt: previousDeletedAt.toISOString(),
          recoverableUntil: existing.purgeEligibleAt?.toISOString() ?? null,
          updatedAt: existing.updatedAt.toISOString(),
        },
        after: { deletedAt: null, updatedAt: version },
        metadata: {
          linkedRecordsPreserved: true,
          automationRemainsPaused: true,
          outboxRemainsQuarantined: true,
          requiresManualAutomationReview: true,
        },
        committedAt: restoredAt,
      });

      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          restored: true,
          restoredAt: version,
          automationRemainsPaused: true,
          outboxRemainsQuarantined: true,
          requiresManualAutomationReview: true,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "contact",
          entityId: restored.id,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        executableClaim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (claim && db) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[team-idempotency] failure_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
