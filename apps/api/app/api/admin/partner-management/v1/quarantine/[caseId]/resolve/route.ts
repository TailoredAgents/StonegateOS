import type { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  partnerInviteOperations,
  partnerLoginTokens,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  hasAcceptedPartnerInviteProviderEvidence,
  partnerQuarantineCaseId,
} from "@/lib/partner-management-quarantine";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ caseId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const InputSchema = z
  .object({
    operationId: z.string().uuid(),
    outcome: z.enum(["confirmed_sent", "confirmed_not_sent"]),
    evidenceType: z.enum([
      "provider_delivery_record",
      "provider_no_matching_send",
      "provider_support_response",
    ]),
    reviewedChannels: z
      .array(z.enum(["email", "sms"]))
      .min(1)
      .max(2)
      .refine((channels) => new Set(channels).size === channels.length),
    providerOperationIds: z.array(z.string().trim().min(1).max(256)).max(10),
    reason: z.string().trim().min(20).max(1_000),
    confirmation: z.enum([
      "RESOLVE AS CONFIRMED SENT",
      "RESOLVE AS CONFIRMED NOT SENT",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedConfirmation =
      value.outcome === "confirmed_sent"
        ? "RESOLVE AS CONFIRMED SENT"
        : "RESOLVE AS CONFIRMED NOT SENT";
    if (value.confirmation !== expectedConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expectedConfirmation} exactly.`,
      });
    }
    if (
      value.outcome === "confirmed_sent" &&
      (value.providerOperationIds.length === 0 ||
        !["provider_delivery_record", "provider_support_response"].includes(
          value.evidenceType,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationIds"],
        message:
          "A confirmed send requires a provider operation ID and delivery evidence.",
      });
    }
    if (
      value.outcome === "confirmed_not_sent" &&
      (value.providerOperationIds.length > 0 ||
        ![
          "provider_no_matching_send",
          "provider_support_response",
        ].includes(value.evidenceType))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message:
          "A confirmed non-send requires non-send evidence and no provider operation ID.",
      });
    }
  });

function integerVersion(value: string | null): number {
  if (!value || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The latest quarantine-case version is required.",
      { fieldErrors: { version: "Refresh the Quarantine workspace." } },
    );
  }
  return Number(value);
}

function channelsMatch(expected: readonly string[], reviewed: readonly string[]) {
  const left = [...new Set(expected)].sort();
  const right = [...new Set(reviewed)].sort();
  return (
    left.length === right.length &&
    left.every((channel, index) => channel === right[index])
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.quarantine.release"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_quarantine.invite_delivery_resolved",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const { caseId: rawCaseId } = await context.params;
  const caseId = rawCaseId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(caseId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid quarantine case.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { caseId: "Refresh the Quarantine workspace." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1_024,
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
      mutation,
    );
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Conclusive provider evidence and the exact confirmation are required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          evidence: "Review every requested channel against provider records.",
          reason: "Explain the evidence in 20–1000 characters.",
          confirmation: "Use the confirmation shown for the selected outcome.",
        },
      },
    );
  }
  if (
    caseId !== partnerQuarantineCaseId("invite_delivery", parsed.data.operationId)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The quarantine case was not found.",
      { status: 404, correlationId: mutation.correlationId },
    );
  }

  let expectedVersion: number;
  try {
    expectedVersion = integerVersion(mutation.expectedVersion);
  } catch (error) {
    return teamMutationExceptionResponse(error, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/quarantine/:caseId/resolve",
      entityType: "partner_quarantine_case",
      entityId: caseId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select({
          id: partnerInviteOperations.id,
          partnerUserId: partnerInviteOperations.partnerUserId,
          orgContactId: partnerInviteOperations.orgContactId,
          operationKind: partnerInviteOperations.operationKind,
          state: partnerInviteOperations.state,
          version: partnerInviteOperations.version,
          requestedChannels: partnerInviteOperations.requestedChannels,
          providerOperationIds: partnerInviteOperations.providerOperationIds,
          providerEvidence: partnerInviteOperations.providerEvidence,
          reconciliationRequiredAt:
            partnerInviteOperations.reconciliationRequiredAt,
          resolvedAt: partnerInviteOperations.resolvedAt,
        })
        .from(partnerInviteOperations)
        .where(eq(partnerInviteOperations.id, parsed.data.operationId))
        .for("update")
        .limit(1);
      if (
        !operation ||
        operation.state !== "reconciliation_required" ||
        operation.resolvedAt
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This case is no longer awaiting provider reconciliation. Refresh the workspace.",
        );
      }
      if (operation.version !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "This case changed after it was loaded. Refresh before resolving it.",
          {
            status: 412,
            fieldErrors: { version: "Refresh the Quarantine workspace." },
          },
        );
      }
      if (!channelsMatch(operation.requestedChannels, parsed.data.reviewedChannels)) {
        throw new TeamMutationFailure(
          "invalid",
          "Provider evidence must cover every requested channel.",
          {
            fieldErrors: {
              reviewedChannels: "Review every requested channel.",
            },
          },
        );
      }
      const knownProviderIds = new Set(operation.providerOperationIds);
      if (
        parsed.data.outcome === "confirmed_not_sent" &&
        (knownProviderIds.size > 0 ||
          hasAcceptedPartnerInviteProviderEvidence(operation.providerEvidence))
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "Durable evidence already records provider acceptance. This case cannot be resolved as not sent.",
          { fieldErrors: { outcome: "Review the recorded acceptance." } },
        );
      }
      if (
        parsed.data.providerOperationIds.some(
          (id) => knownProviderIds.size > 0 && !knownProviderIds.has(id),
        )
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "A supplied provider operation ID conflicts with durable evidence.",
          {
            fieldErrors: {
              providerOperationIds: "Use only IDs from the provider record.",
            },
          },
        );
      }

      const resolvedAt = new Date(
        Math.max(
          Date.now(),
          (operation.reconciliationRequiredAt?.getTime() ?? 0) + 1,
        ),
      );
      const invalidatedTokens =
        parsed.data.outcome === "confirmed_not_sent"
          ? await tx
              .update(partnerLoginTokens)
              .set({ usedAt: resolvedAt })
              .where(
                and(
                  eq(partnerLoginTokens.partnerUserId, operation.partnerUserId),
                  isNull(partnerLoginTokens.usedAt),
                ),
              )
              .returning({ id: partnerLoginTokens.id })
          : [];
      const nextVersion = operation.version + 1;
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_quarantine_case",
        entityId: caseId,
        before: {
          caseKind: "invite_delivery",
          status: "reconciliation_required",
          operationVersion: operation.version,
        },
        after: {
          caseKind: "invite_delivery",
          status: "resolved",
          operationVersion: nextVersion,
          resolution: parsed.data.outcome,
        },
        metadata: {
          sourceOperationId: operation.id,
          partnerUserId: operation.partnerUserId,
          legacyOrgContactId: operation.orgContactId,
          operationKind: operation.operationKind,
          evidenceType: parsed.data.evidenceType,
          reviewedChannels: parsed.data.reviewedChannels,
          providerOperationIds: parsed.data.providerOperationIds,
          reasonLength: parsed.data.reason.length,
          providerCalled: false,
          automaticRedispatchAttempted: false,
          originalProviderOutcomePreserved: true,
          loginTokensInvalidatedCount: invalidatedTokens.length,
        },
        committedAt: resolvedAt,
      });
      const [resolved] = await tx
        .update(partnerInviteOperations)
        .set({
          resolution: parsed.data.outcome,
          resolutionEvidence: parsed.data.reason,
          resolvedAt,
          resolvedBy: mutation.actor.id!,
          resolutionAuditEventId: audit.auditEventId,
          version: nextVersion,
          updatedAt: resolvedAt,
        })
        .where(
          and(
            eq(partnerInviteOperations.id, operation.id),
            eq(partnerInviteOperations.state, "reconciliation_required"),
            eq(partnerInviteOperations.version, operation.version),
            isNull(partnerInviteOperations.resolvedAt),
          ),
        )
        .returning({ version: partnerInviteOperations.version });
      if (!resolved) {
        throw new TeamMutationFailure(
          "conflict",
          "Another reviewer resolved this case first. Refresh the workspace.",
        );
      }

      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          caseId,
          caseKind: "invite_delivery",
          status: "resolved",
          resolution: parsed.data.outcome,
          operationVersion: resolved.version,
          providerCalled: false,
          automaticRedispatchAttempted: false,
          loginTokensInvalidated: invalidatedTokens.length,
          version: String(resolved.version),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_quarantine_case",
          entityId: caseId,
          version: String(resolved.version),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        resolvedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error(
          "[partner-management] quarantine_resolution_settlement_failed",
          {
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
