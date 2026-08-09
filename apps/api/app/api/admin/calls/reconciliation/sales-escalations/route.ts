import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  callRecords,
  crmTasks,
  getDb,
  salesEscalationCallCallbackEvents,
  salesEscalationCallOperations,
  salesEscalationCallReconciliationSidClaims,
  salesEscalationCallReconciliations,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  assertSalesEscalationReconciliationSidConsistency,
  classifySalesEscalationReconciliationTaskEffect,
  planSalesEscalationCallReconciliation,
  SalesEscalationCallReconciliationSchema,
} from "@/lib/sales-escalation-call-reconciliation";
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

function requiredIntegerVersion(value: string | null): number {
  if (!value || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The latest escalation call version is required.",
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

function boundedRequestFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return new TeamMutationFailure(
      "invalid",
      "The reconciliation request body is invalid.",
    );
  }
  return new TeamMutationFailure(
    error.code === "body_timeout" ? "timeout" : "invalid",
    error.message,
    {
      status: error.status,
      retryable: error.code === "body_timeout",
    },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["calls.reconcile"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sales.escalation.call.reconciled",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let candidate: unknown;
  try {
    candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      deadlineMs: 10_000,
    });
  } catch (error) {
    const failure = boundedRequestFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "sales_escalation_call_operation",
      code: failure.code,
      metadata: { boundary: "bounded_input", providerCalled: false },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const parsed = SalesEscalationCallReconciliationSchema.safeParse(candidate);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "sales_escalation_call_operation",
      code: "invalid",
      metadata: { boundary: "input_validation", providerCalled: false },
    });
    return teamMutationExceptionResponse(
      new TeamMutationFailure(
        "invalid",
        "The escalation-call evidence or typed confirmation is incomplete.",
        {
          fieldErrors: {
            confirmation: 'Type "RECONCILE CALL" exactly.',
            evidence: "Provide the exact reviewed Twilio records.",
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
      entityType: "sales_escalation_call_operation",
      entityId: parsed.data.salesEscalationOperationId,
      code: "invalid",
      metadata: { boundary: "expected_version", providerCalled: false },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/calls/reconciliation/sales-escalations",
      entityType: "sales_escalation_call_operation",
      entityId: parsed.data.salesEscalationOperationId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const reconciliationClaim = claimed.claim;
    claim = reconciliationClaim;
    const reviewer = requireReviewer(mutation);

    const completed = await db.transaction(async (tx) => {
      const [candidateOperation] = await tx
        .select({ contactId: salesEscalationCallOperations.contactId })
        .from(salesEscalationCallOperations)
        .where(
          eq(
            salesEscalationCallOperations.id,
            parsed.data.salesEscalationOperationId,
          ),
        )
        .limit(1);
      if (!candidateOperation) {
        throw new TeamMutationFailure(
          "conflict",
          "This escalation call no longer exists. Refresh the queue.",
        );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidateOperation.contactId}, 0))`,
      );
      const [operation] = await tx
        .select()
        .from(salesEscalationCallOperations)
        .where(
          eq(
            salesEscalationCallOperations.id,
            parsed.data.salesEscalationOperationId,
          ),
        )
        .for("update")
        .limit(1);
      if (!operation) {
        throw new TeamMutationFailure(
          "conflict",
          "This escalation call no longer exists. Refresh the queue.",
        );
      }
      if (operation.version !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "This escalation call changed after it was loaded. Refresh before reviewing it.",
          { fieldErrors: { version: "Refresh the reconciliation queue." } },
        );
      }

      const priorSidEvidence = await tx
        .select({
          operationId: salesEscalationCallReconciliations.operationId,
          providerOperationId:
            salesEscalationCallReconciliations.providerOperationId,
          providerCustomerOperationId:
            salesEscalationCallReconciliations.providerCustomerOperationId,
        })
        .from(salesEscalationCallReconciliations)
        .where(
          eq(salesEscalationCallReconciliations.operationId, operation.id),
        );

      // The operation row is locked before callback aggregation. A signed
      // callback either commits first and is included here, or waits and is
      // appended as late evidence after a decisive review commits.
      const [callbackEvidence] = await tx
        .select({
          count: sql<number>`count(*)::int`.mapWith(Number),
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
        .where(eq(salesEscalationCallCallbackEvents.operationId, operation.id));
      const evidenceSummary = {
        count: callbackEvidence?.count ?? 0,
        hasAppliedEvidence: callbackEvidence?.hasAppliedEvidence ?? false,
        hasAnomaly: callbackEvidence?.hasAnomaly ?? false,
      };
      const plan = planSalesEscalationCallReconciliation(
        operation,
        evidenceSummary,
        parsed.data,
      );

      const reviewedSids = [
        plan.providerOperationId,
        plan.providerCustomerOperationId,
      ]
        .filter((sid): sid is string => Boolean(sid))
        .sort();
      for (const sid of [...new Set(reviewedSids)]) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`twilio-call-sid:${sid}`}, 0))`,
        );
      }
      const operationSidOwners = await tx
        .select({
          sid: salesEscalationCallReconciliationSidClaims.sid,
          operationId: salesEscalationCallReconciliationSidClaims.operationId,
          leg: salesEscalationCallReconciliationSidClaims.leg,
        })
        .from(salesEscalationCallReconciliationSidClaims)
        .where(
          eq(
            salesEscalationCallReconciliationSidClaims.operationId,
            operation.id,
          ),
        );
      const reviewedSidOwners = reviewedSids.length
        ? await tx
            .select({
              sid: salesEscalationCallReconciliationSidClaims.sid,
              operationId:
                salesEscalationCallReconciliationSidClaims.operationId,
              leg: salesEscalationCallReconciliationSidClaims.leg,
            })
            .from(salesEscalationCallReconciliationSidClaims)
            .where(
              inArray(
                salesEscalationCallReconciliationSidClaims.sid,
                reviewedSids,
              ),
            )
        : [];
      const sidOwners = [
        ...new Map(
          [...operationSidOwners, ...reviewedSidOwners].map((owner) => [
            owner.sid,
            owner,
          ]),
        ).values(),
      ];
      assertSalesEscalationReconciliationSidConsistency(
        {
          operationId: operation.id,
          providerOperationId: plan.providerOperationId,
          providerCustomerOperationId: plan.providerCustomerOperationId,
        },
        priorSidEvidence,
        sidOwners,
      );
      if (reviewedSids.length > 0) {
        const sidMatches = reviewedSids.flatMap((sid) => [
          eq(salesEscalationCallOperations.providerOperationId, sid),
          eq(salesEscalationCallOperations.providerCustomerOperationId, sid),
        ]);
        const reviewSidMatches = reviewedSids.flatMap((sid) => [
          eq(salesEscalationCallReconciliations.providerOperationId, sid),
          eq(
            salesEscalationCallReconciliations.providerCustomerOperationId,
            sid,
          ),
        ]);
        const [conflictingOperation] = await tx
          .select({ id: salesEscalationCallOperations.id })
          .from(salesEscalationCallOperations)
          .where(
            and(
              ne(salesEscalationCallOperations.id, operation.id),
              or(...sidMatches),
            ),
          )
          .limit(1);
        const [conflictingReview] = await tx
          .select({
            operationId: salesEscalationCallReconciliations.operationId,
          })
          .from(salesEscalationCallReconciliations)
          .where(
            and(
              ne(salesEscalationCallReconciliations.operationId, operation.id),
              or(...reviewSidMatches),
            ),
          )
          .limit(1);
        if (conflictingOperation || conflictingReview) {
          throw new TeamMutationFailure(
            "conflict",
            "One of the reviewed Twilio call SIDs is already attached to another operation or review.",
            { fieldErrors: { evidence: "Verify both Twilio call SIDs." } },
          );
        }
      }

      let taskEffect:
        | "pending"
        | "completed"
        | "stale"
        | "already_terminal"
        | "not_dispatched" =
        parsed.data.outcome === "confirmed_not_dispatched"
          ? "not_dispatched"
          : "pending";
      let shouldCompleteTask = false;
      if (parsed.data.outcome === "confirmed_connected") {
        const [task] = await tx
          .select({
            contactId: crmTasks.contactId,
            assignedTo: crmTasks.assignedTo,
            status: crmTasks.status,
            updatedAt: crmTasks.updatedAt,
          })
          .from(crmTasks)
          .where(eq(crmTasks.id, operation.taskId))
          .for("update")
          .limit(1);
        const plannedTaskEffect =
          classifySalesEscalationReconciliationTaskEffect(
            task ?? null,
            operation,
          );
        if (plannedTaskEffect === "complete") {
          shouldCompleteTask = true;
          taskEffect = "completed";
        } else {
          taskEffect = plannedTaskEffect;
        }
      }

      let existingCallRecord: {
        id: string;
        parentCallSid: string | null;
        direction: string;
        mode: string | null;
        contactId: string | null;
        assignedTo: string | null;
        callStatus: string | null;
        callDurationSec: number | null;
      } | null = null;
      if (plan.terminalOutcome === "connected") {
        const [existing] = await tx
          .select({
            id: callRecords.id,
            parentCallSid: callRecords.parentCallSid,
            direction: callRecords.direction,
            mode: callRecords.mode,
            contactId: callRecords.contactId,
            assignedTo: callRecords.assignedTo,
            callStatus: callRecords.callStatus,
            callDurationSec: callRecords.callDurationSec,
          })
          .from(callRecords)
          .where(
            eq(callRecords.callSid, plan.providerCustomerOperationId as string),
          )
          .for("update")
          .limit(1);
        existingCallRecord = existing ?? null;
        if (
          existingCallRecord &&
          (existingCallRecord.parentCallSid !== plan.providerOperationId ||
            existingCallRecord.direction !== "outbound" ||
            existingCallRecord.mode !== "sales_escalation" ||
            existingCallRecord.contactId !== operation.contactId ||
            existingCallRecord.assignedTo !== operation.agentMemberId ||
            existingCallRecord.callStatus !== "completed" ||
            existingCallRecord.callDurationSec !==
              parsed.data.connectedDurationSec)
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "The existing CRM call record conflicts with the reviewed Twilio evidence.",
            { fieldErrors: { evidence: "Recheck the customer call record." } },
          );
        }
      }

      const reconciliationId = randomUUID();
      const reviewedAt = new Date(
        Math.max(
          Date.now(),
          operation.reconciliationRequiredAt?.getTime() ?? 0,
        ),
      );
      const sidClaims = [
        ...(plan.providerOperationId
          ? [{ sid: plan.providerOperationId, leg: "parent" as const }]
          : []),
        ...(plan.providerCustomerOperationId
          ? [
              {
                sid: plan.providerCustomerOperationId,
                leg: "customer" as const,
              },
            ]
          : []),
      ];
      for (const sidClaim of sidClaims) {
        await tx
          .insert(salesEscalationCallReconciliationSidClaims)
          .values({
            sid: sidClaim.sid,
            operationId: operation.id,
            leg: sidClaim.leg,
            firstReconciliationId: reconciliationId,
            createdAt: reviewedAt,
          })
          .onConflictDoNothing();
        const [owner] = await tx
          .select({
            operationId: salesEscalationCallReconciliationSidClaims.operationId,
            leg: salesEscalationCallReconciliationSidClaims.leg,
          })
          .from(salesEscalationCallReconciliationSidClaims)
          .where(
            eq(salesEscalationCallReconciliationSidClaims.sid, sidClaim.sid),
          )
          .for("update")
          .limit(1);
        if (
          !owner ||
          owner.operationId !== operation.id ||
          owner.leg !== sidClaim.leg
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "A Twilio call SID was claimed by another operation or call leg during review.",
            { fieldErrors: { evidence: "Refresh and verify both call SIDs." } },
          );
        }
      }
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "sales_escalation_call_operation",
        entityId: operation.id,
        before: {
          state: operation.state,
          version: operation.version,
          reconciliationBlocked: true,
          terminalOutcome: operation.terminalOutcome,
          taskEffect: operation.taskEffect,
        },
        after: {
          state: operation.state,
          version: operation.version + 1,
          reconciliationBlocked: !plan.decisive,
          terminalOutcome: plan.terminalOutcome,
          taskEffect,
        },
        metadata: {
          reconciliationId,
          outcome: parsed.data.outcome,
          evidenceType: parsed.data.evidenceType,
          suppliedProviderOperationId: plan.providerOperationId,
          suppliedProviderCustomerOperationId: plan.providerCustomerOperationId,
          suppliedProviderCallStatus: parsed.data.providerCallStatus ?? null,
          suppliedProviderCustomerStatus:
            parsed.data.providerCustomerStatus ?? null,
          connectedDurationSec: parsed.data.connectedDurationSec ?? null,
          providerEvidenceSource: "operator_supplied",
          originalProviderOutcomePreserved: true,
          providerCalled: false,
          providerReplayAttempted: false,
          signedCallbackEvidenceCount: evidenceSummary.count,
          signedCallbackAnomalyPresent: evidenceSummary.hasAnomaly,
          taskEffect,
          callRecordCreated:
            plan.terminalOutcome === "connected" && !existingCallRecord,
          reasonRecorded: true,
          reasonLength: parsed.data.reason.length,
        },
        providerOperationId: plan.providerOperationId,
        committedAt: reviewedAt,
      });

      await tx.insert(salesEscalationCallReconciliations).values({
        id: reconciliationId,
        operationId: operation.id,
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
        providerOperationId: plan.providerOperationId,
        providerCustomerOperationId: plan.providerCustomerOperationId,
        providerCallStatus: parsed.data.providerCallStatus ?? null,
        providerCustomerStatus: parsed.data.providerCustomerStatus ?? null,
        connectedDurationSec: parsed.data.connectedDurationSec ?? null,
        reason: parsed.data.reason,
        auditEventId: audit.auditEventId,
        createdAt: reviewedAt,
      });

      if (shouldCompleteTask) {
        const [completedTask] = await tx
          .update(crmTasks)
          .set({ status: "completed", updatedAt: reviewedAt })
          .where(
            and(
              eq(crmTasks.id, operation.taskId),
              eq(crmTasks.contactId, operation.contactId),
              eq(crmTasks.assignedTo, operation.agentMemberId),
              eq(crmTasks.status, "open"),
              eq(crmTasks.updatedAt, operation.taskUpdatedAt),
            ),
          )
          .returning({ id: crmTasks.id });
        if (!completedTask) {
          throw new TeamMutationFailure(
            "conflict",
            "The sales task changed during reconciliation. Refresh and review it again.",
          );
        }
      }

      let callRecordId = existingCallRecord?.id ?? null;
      if (plan.terminalOutcome === "connected" && !existingCallRecord) {
        const [createdCallRecord] = await tx
          .insert(callRecords)
          .values({
            callSid: plan.providerCustomerOperationId as string,
            parentCallSid: plan.providerOperationId,
            direction: "outbound",
            mode: "sales_escalation",
            from: operation.agentPhoneE164,
            to: operation.customerPhoneE164,
            contactId: operation.contactId,
            assignedTo: operation.agentMemberId,
            callStatus: "completed",
            callDurationSec: parsed.data.connectedDurationSec,
            createdAt: reviewedAt,
            updatedAt: reviewedAt,
          })
          .returning({ id: callRecords.id });
        if (!createdCallRecord) {
          throw new TeamMutationFailure(
            "internal",
            "The reviewed call record could not be committed.",
          );
        }
        callRecordId = createdCallRecord.id;
      }

      const operationChanges = plan.decisive
        ? {
            reconciliationResolutionId: reconciliationId,
            reconciliationResolvedAt: reviewedAt,
            providerOperationId: plan.providerOperationId,
            providerCustomerOperationId: plan.providerCustomerOperationId,
            terminalAuditEventId: audit.auditEventId,
            terminalOutcome: plan.terminalOutcome,
            outcomeReason: plan.outcomeReason,
            taskEffect,
            taskEffectAt: reviewedAt,
            terminalAt: reviewedAt,
            guardReleasedAt: reviewedAt,
            version: operation.version + 1,
            updatedAt: reviewedAt,
          }
        : {
            version: operation.version + 1,
            updatedAt: reviewedAt,
          };
      const [updatedOperation] = await tx
        .update(salesEscalationCallOperations)
        .set(operationChanges)
        .where(
          and(
            eq(salesEscalationCallOperations.id, operation.id),
            eq(salesEscalationCallOperations.state, "reconciliation_required"),
            eq(salesEscalationCallOperations.version, operation.version),
            isNull(salesEscalationCallOperations.reconciliationResolutionId),
            isNull(salesEscalationCallOperations.terminalAt),
          ),
        )
        .returning({ version: salesEscalationCallOperations.version });
      if (!updatedOperation) {
        throw new TeamMutationFailure(
          "conflict",
          "Another callback or reviewer changed this call first. Refresh the queue.",
        );
      }

      const data = {
        reconciliationId,
        salesEscalationOperationId: operation.id,
        operationState: "reconciliation_required" as const,
        outcome: parsed.data.outcome,
        evidenceType: parsed.data.evidenceType,
        providerEvidenceSource: "operator_supplied" as const,
        originalProviderOutcomePreserved: true as const,
        providerReplayAttempted: false as const,
        contactCallBlockCleared: plan.decisive,
        taskEffect,
        callRecordId,
        operationVersion: updatedOperation.version,
      };
      const result = teamMutationSuccessResult(mutation, data, {
        committedAt: audit.committedAt,
        auditEventId: audit.auditEventId,
        entityType: "sales_escalation_call_operation",
        entityId: operation.id,
        version: updatedOperation.version,
        ...(plan.providerOperationId
          ? { providerOperationId: plan.providerOperationId }
          : {}),
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
      entityType: "sales_escalation_call_operation",
      entityId: parsed.data.salesEscalationOperationId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        boundary: "reconciliation_commit",
        providerCalled: false,
        providerReplayAttempted: false,
        originalProviderOutcomePreserved: true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
