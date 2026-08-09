import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts,
  getDb,
  salesEscalationCallCallbackEvents,
  salesEscalationCallOperations,
  teamCallOperationTaskIntents,
  teamCallOperationReconciliations,
  teamCallOperations,
  teamMembers,
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  completeSnapshottedTasks,
  quarantineStaleManualCalls,
} from "@/lib/manual-call-callbacks";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { isAdminRequest } from "../../../web/admin";

const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;
const ReconciliationSchema = z
  .object({
    callOperationId: z.string().uuid(),
    confirmation: z.literal("RECONCILE CALL"),
    outcome: z.enum([
      "confirmed_connected",
      "confirmed_not_connected",
      "confirmed_not_dispatched",
      "confirmed_active",
      "still_uncertain",
    ]),
    evidenceType: z.enum([
      "provider_call_record",
      "provider_no_matching_call",
      "provider_support_response",
      "operator_investigation",
    ]),
    providerOperationId: z.string().trim().max(64).nullable().optional(),
    providerStatus: z.number().int().min(100).max(599).nullable().optional(),
    reason: z.string().trim().min(20).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    const providerOperationId = value.providerOperationId ?? null;
    if (providerOperationId && !CALL_SID_PATTERN.test(providerOperationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationId"],
        message: "Use the exact Twilio call SID from the reviewed record.",
      });
    }
    if (
      [
        "confirmed_connected",
        "confirmed_not_connected",
        "confirmed_active",
      ].includes(value.outcome) &&
      (!providerOperationId ||
        !["provider_call_record", "provider_support_response"].includes(
          value.evidenceType,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationId"],
        message:
          "A provider-confirmed call requires a Twilio call SID and provider evidence.",
      });
    }
    if (
      value.outcome === "confirmed_not_dispatched" &&
      (providerOperationId !== null ||
        !["provider_no_matching_call", "provider_support_response"].includes(
          value.evidenceType,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message:
          "A confirmed-not-dispatched result requires provider evidence and no call SID.",
      });
    }
  });

async function authorizeRead(request: NextRequest): Promise<Response | null> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return requirePermission(request, "calls.reconcile");
}

export async function GET(request: NextRequest): Promise<Response> {
  const authorizationError = await authorizeRead(request);
  if (authorizationError) return authorizationError;

  const db = getDb();
  // The read path invokes the bounded stale scanner so missing callbacks can
  // never strand a contact outside the visible reconciliation queue. The
  // scanner only quarantines; it never releases a guard or retries Twilio.
  await quarantineStaleManualCalls({ db, limit: 25 });
  // Fetch at most one row beyond the response boundary from each indexed
  // ledger. The final merged response is still capped at 100 records.
  const [manualRows, escalationRows] = await Promise.all([
    db
      .select({
        id: teamCallOperations.id,
        contactId: teamCallOperations.contactId,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        agentMemberId: teamCallOperations.agentMemberId,
        actorLabel: teamCallOperations.actorLabel,
        state: teamCallOperations.state,
        version: teamCallOperations.version,
        provider: teamCallOperations.provider,
        providerOperationId: teamCallOperations.providerOperationId,
        providerStatus: teamCallOperations.providerStatus,
        failureCode: teamCallOperations.failureCode,
        failureDetail: teamCallOperations.failureDetail,
        requestedAt: teamCallOperations.requestedAt,
        dispatchedAt: teamCallOperations.dispatchedAt,
        reconciliationRequiredAt:
          teamCallOperations.reconciliationRequiredAt,
      })
      .from(teamCallOperations)
      .leftJoin(contacts, eq(contacts.id, teamCallOperations.contactId))
      .where(
        and(
          eq(teamCallOperations.state, "reconciliation_required"),
          isNull(teamCallOperations.reconciliationResolutionId),
        ),
      )
      .orderBy(desc(teamCallOperations.reconciliationRequiredAt))
      .limit(101),
    db
      .select({
        id: salesEscalationCallOperations.id,
        contactId: salesEscalationCallOperations.contactId,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        agentMemberId: salesEscalationCallOperations.agentMemberId,
        actorLabel: teamMembers.name,
        taskId: salesEscalationCallOperations.taskId,
        state: salesEscalationCallOperations.state,
        version: salesEscalationCallOperations.version,
        provider: salesEscalationCallOperations.provider,
        providerOperationId:
          salesEscalationCallOperations.providerOperationId,
        providerCustomerOperationId:
          salesEscalationCallOperations.providerCustomerOperationId,
        deliveryCertainty: salesEscalationCallOperations.deliveryCertainty,
        providerStatus: salesEscalationCallOperations.providerStatus,
        failureCode: salesEscalationCallOperations.failureCode,
        failureDetail: salesEscalationCallOperations.failureDetail,
        requestedAt: salesEscalationCallOperations.requestedAt,
        dispatchedAt: salesEscalationCallOperations.dispatchedAt,
        providerAcceptedAt:
          salesEscalationCallOperations.providerAcceptedAt,
        callbackDeadlineAt:
          salesEscalationCallOperations.callbackDeadlineAt,
        reconciliationRequiredAt:
          salesEscalationCallOperations.reconciliationRequiredAt,
      })
      .from(salesEscalationCallOperations)
      .leftJoin(
        contacts,
        eq(contacts.id, salesEscalationCallOperations.contactId),
      )
      .leftJoin(
        teamMembers,
        eq(teamMembers.id, salesEscalationCallOperations.agentMemberId),
      )
      .where(
        and(
          eq(
            salesEscalationCallOperations.state,
            "reconciliation_required",
          ),
          isNull(
            salesEscalationCallOperations.reconciliationResolutionId,
          ),
          isNull(salesEscalationCallOperations.guardReleasedAt),
        ),
      )
      .orderBy(
        desc(salesEscalationCallOperations.reconciliationRequiredAt),
      )
      .limit(101),
  ]);

  const escalationIds = escalationRows.map((row) => row.id);
  const callbackRows = escalationIds.length
    ? await db
        .select({
          operationId: salesEscalationCallCallbackEvents.operationId,
          count: sql<number>`count(*)::int`.mapWith(Number),
          lastReceivedAt: sql<Date | null>`max(${salesEscalationCallCallbackEvents.receivedAt})`,
          hasAppliedEvidence:
            sql<boolean>`coalesce(bool_or(${salesEscalationCallCallbackEvents.applyResult} = 'applied'), false)`.mapWith(
              Boolean,
            ),
          hasAnomaly:
            sql<boolean>`coalesce(bool_or(${salesEscalationCallCallbackEvents.applyResult} = 'anomaly'), false)`.mapWith(
              Boolean,
            ),
        })
        .from(salesEscalationCallCallbackEvents)
        .where(
          inArray(
            salesEscalationCallCallbackEvents.operationId,
            escalationIds,
          ),
        )
        .groupBy(salesEscalationCallCallbackEvents.operationId)
    : [];
  const callbackByOperation = new Map(
    callbackRows.map((row) => [row.operationId, row] as const),
  );

  const items = [
    ...manualRows.map(
      ({ contactFirstName, contactLastName, ...row }) => ({
        ...row,
        operationKind: "manual" as const,
        reconciliationRequiredAt:
          row.reconciliationRequiredAt ?? row.requestedAt,
        contactName:
          [contactFirstName, contactLastName]
            .filter((part): part is string => Boolean(part?.trim()))
            .join(" ") || null,
        providerEvidenceStatus:
          "unverified_operator_review_required" as const,
        providerOutcomePreserved: true as const,
      }),
    ),
    ...escalationRows.map(
      ({ contactFirstName, contactLastName, ...row }) => {
        const callbackEvidence = callbackByOperation.get(row.id);
        return {
          ...row,
          operationKind: "sales_escalation" as const,
          reconciliationRequiredAt:
            row.reconciliationRequiredAt ?? row.requestedAt,
          contactName:
            [contactFirstName, contactLastName]
              .filter((part): part is string => Boolean(part?.trim()))
              .join(" ") || null,
          callbackEvidence: {
            count: callbackEvidence?.count ?? 0,
            lastReceivedAt: callbackEvidence?.lastReceivedAt ?? null,
            hasAppliedEvidence:
              callbackEvidence?.hasAppliedEvidence ?? false,
            hasAnomaly: callbackEvidence?.hasAnomaly ?? false,
          },
          providerEvidenceStatus:
            "unverified_operator_review_required" as const,
          providerOutcomePreserved: true as const,
        };
      },
    ),
  ].sort(
    (left, right) =>
      right.reconciliationRequiredAt.getTime() -
      left.reconciliationRequiredAt.getTime(),
  );
  const truncated = items.length > 100;

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      truncated,
      items: items.slice(0, 100),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function requiredIntegerVersion(value: string | null): number {
  if (!value || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The latest call operation version is required.",
      { fieldErrors: { version: "Refresh the reconciliation queue." } },
    );
  }
  return Number(value);
}

function requireReviewer(mutation: {
  principalType: string;
  actor: {
    id?: string | null;
    sessionId?: string | null;
    authMethod?: string | null;
    label?: string | null;
    role?: string | null;
  };
}): {
  memberId: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
} {
  const authMethod = mutation.actor.authMethod;
  if (
    mutation.principalType !== "human" ||
    !mutation.actor.id ||
    !mutation.actor.sessionId ||
    (authMethod !== "team_session" && authMethod !== "break_glass")
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The verified reconciliation reviewer is incomplete.",
    );
  }
  return {
    memberId: mutation.actor.id,
    sessionId: mutation.actor.sessionId,
    authMethod,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["calls.reconcile"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "call.reconciled",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsed = ReconciliationSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "team_call_operation",
      code: "invalid",
      metadata: { boundary: "input_validation", providerCalled: false },
    });
    return teamMutationExceptionResponse(
      new TeamMutationFailure(
        "invalid",
        "The reconciliation evidence or typed confirmation is incomplete.",
        {
          fieldErrors: {
            confirmation: 'Type "RECONCILE CALL" exactly.',
            evidence: "Provide the exact reviewed provider evidence.",
            reason: "Explain the review in at least 20 characters.",
          },
        },
      ),
      mutation,
    );
  }

  let expectedVersion: number;
  try {
    expectedVersion = requiredIntegerVersion(mutation.expectedVersion);
  } catch (error) {
    await recordTeamMutationFailure(mutation, {
      entityType: "team_call_operation",
      entityId: parsed.data.callOperationId,
      code: "invalid",
      metadata: { boundary: "expected_version", providerCalled: false },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/calls/reconciliation",
      entityType: "team_call_operation",
      entityId: parsed.data.callOperationId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const reconciliationClaim = claimed.claim;
    claim = reconciliationClaim;
    const reviewer = requireReviewer(mutation);

    const completed = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ contactId: teamCallOperations.contactId })
        .from(teamCallOperations)
        .where(eq(teamCallOperations.id, parsed.data.callOperationId))
        .limit(1);
      if (!candidate) {
        throw new TeamMutationFailure(
          "conflict",
          "This call attempt no longer exists. Refresh the queue.",
        );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
      );
      const [operation] = await tx
        .select()
        .from(teamCallOperations)
        .where(eq(teamCallOperations.id, parsed.data.callOperationId))
        .for("update")
        .limit(1);
      if (!operation) {
        throw new TeamMutationFailure(
          "conflict",
          "This call attempt no longer exists. Refresh the queue.",
        );
      }
      if (
        operation.state !== "reconciliation_required" ||
        operation.reconciliationResolutionId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This call attempt is no longer awaiting reconciliation. Refresh the queue.",
        );
      }
      if (operation.version !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "This call attempt changed after it was loaded. Refresh before reviewing it.",
          { fieldErrors: { version: "Refresh the reconciliation queue." } },
        );
      }
      const suppliedProviderOperationId =
        parsed.data.providerOperationId ?? null;
      if (
        suppliedProviderOperationId &&
        operation.providerOperationId &&
        suppliedProviderOperationId !== operation.providerOperationId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The reviewed Twilio call SID conflicts with the call already bound to this attempt. Refresh and verify the provider record.",
          { fieldErrors: { providerOperationId: "Use the bound call SID." } },
        );
      }
      if (
        parsed.data.outcome === "confirmed_not_dispatched" &&
        operation.providerOperationId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This attempt already has a verified Twilio call SID and cannot be marked not dispatched.",
          { fieldErrors: { outcome: "Review the bound provider call." } },
        );
      }

      const reconciliationId = randomUUID();
      const reviewedAt = new Date();
      const decisive = [
        "confirmed_connected",
        "confirmed_not_connected",
        "confirmed_not_dispatched",
      ].includes(parsed.data.outcome);
      const terminalOutcome =
        parsed.data.outcome === "confirmed_connected"
          ? ("connected" as const)
          : parsed.data.outcome === "confirmed_not_connected"
            ? ("not_connected" as const)
            : parsed.data.outcome === "confirmed_not_dispatched"
              ? ("not_dispatched" as const)
              : null;
      const outcomeReason = terminalOutcome
        ? `operator_confirmed_${terminalOutcome}`
        : null;
      let taskEffects = {
        completedExplicitTaskId: null as string | null,
        completedFollowupTaskId: null as string | null,
        completedSpeedToLeadCount: 0,
      };
      if (parsed.data.outcome === "confirmed_connected") {
        taskEffects = await completeSnapshottedTasks(tx, operation, reviewedAt);
      } else if (parsed.data.outcome === "confirmed_not_connected") {
        await tx
          .update(teamCallOperationTaskIntents)
          .set({ effect: "not_connected", effectAt: reviewedAt })
          .where(
            and(
              eq(teamCallOperationTaskIntents.callOperationId, operation.id),
              eq(teamCallOperationTaskIntents.effect, "pending"),
            ),
          );
      } else if (parsed.data.outcome === "confirmed_not_dispatched") {
        await tx
          .update(teamCallOperationTaskIntents)
          .set({ effect: "not_dispatched", effectAt: reviewedAt })
          .where(
            and(
              eq(teamCallOperationTaskIntents.callOperationId, operation.id),
              eq(teamCallOperationTaskIntents.effect, "pending"),
            ),
          );
      }
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_call_operation",
        entityId: operation.id,
        before: {
          state: operation.state,
          version: operation.version,
          reconciliationBlocked: true,
        },
        after: {
          state: operation.state,
          version: operation.version + (decisive ? 1 : 0),
          reconciliationBlocked: !decisive,
        },
        metadata: {
          reconciliationId,
          outcome: parsed.data.outcome,
          evidenceType: parsed.data.evidenceType,
          suppliedProviderOperationId: parsed.data.providerOperationId ?? null,
          suppliedProviderStatus: parsed.data.providerStatus ?? null,
          providerEvidenceSource: "operator_supplied",
          originalProviderOutcomePreserved: true,
          taskEffectsApplied: parsed.data.outcome === "confirmed_connected",
          ...taskEffects,
          reasonRecorded: true,
          reasonLength: parsed.data.reason.length,
        },
        committedAt: reviewedAt,
      });

      await tx.insert(teamCallOperationReconciliations).values({
        id: reconciliationId,
        callOperationId: operation.id,
        mutationClaimId: reconciliationClaim.id,
        reviewerMemberId: reviewer.memberId,
        reviewerLabel: mutation.actor.label ?? null,
        reviewerRole: mutation.actor.role ?? null,
        reviewerSessionId: reviewer.sessionId,
        reviewerAuthMethod: reviewer.authMethod,
        correlationId: mutation.correlationId,
        idempotencyKeyHash: reconciliationClaim.keyHash,
        expectedOperationVersion: expectedVersion,
        outcome: parsed.data.outcome,
        evidenceType: parsed.data.evidenceType,
        providerOperationId: parsed.data.providerOperationId ?? null,
        providerStatus: parsed.data.providerStatus ?? null,
        reason: parsed.data.reason,
        auditEventId: audit.auditEventId,
        createdAt: reviewedAt,
      });

      let operationVersion = operation.version;
      if (decisive) {
        const [resolved] = await tx
          .update(teamCallOperations)
          .set({
            reconciliationResolutionId: reconciliationId,
            reconciliationResolvedAt: reviewedAt,
            terminalOutcome,
            outcomeReason,
            guardReleasedAt: reviewedAt,
            completedExplicitTaskId:
              parsed.data.outcome === "confirmed_connected"
                ? taskEffects.completedExplicitTaskId
                : null,
            completedFollowupTaskId:
              parsed.data.outcome === "confirmed_connected"
                ? taskEffects.completedFollowupTaskId
                : null,
            completedSpeedToLeadCount:
              parsed.data.outcome === "confirmed_connected"
                ? taskEffects.completedSpeedToLeadCount
                : 0,
            version: operation.version + 1,
            updatedAt: reviewedAt,
          })
          .where(
            and(
              eq(teamCallOperations.id, operation.id),
              eq(teamCallOperations.state, "reconciliation_required"),
              eq(teamCallOperations.version, operation.version),
              isNull(teamCallOperations.reconciliationResolutionId),
            ),
          )
          .returning({ version: teamCallOperations.version });
        if (!resolved) {
          throw new TeamMutationFailure(
            "conflict",
            "Another reviewer resolved this call first. Refresh the queue.",
          );
        }
        operationVersion = resolved.version;
      }

      const data = {
        reconciliationId,
        callOperationId: operation.id,
        outcome: parsed.data.outcome,
        evidenceType: parsed.data.evidenceType,
        providerEvidenceSource: "operator_supplied" as const,
        originalProviderOutcomePreserved: true as const,
        contactCallBlockCleared: decisive,
        operationVersion,
      };
      const result = teamMutationSuccessResult(mutation, data, {
        committedAt: audit.committedAt,
        auditEventId: audit.auditEventId,
        entityType: "team_call_operation",
        entityId: operation.id,
        version: operationVersion,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        reconciliationClaim,
        result,
        200,
        reviewedAt,
      );
      return result;
    });

    return teamMutationResultResponse(completed, 200, mutation.correlationId);
  } catch (error) {
    if (claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "team_call_operation",
      entityId: parsed.data.callOperationId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        boundary: "reconciliation_commit",
        providerCalled: false,
        originalProviderOutcomePreserved: true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
