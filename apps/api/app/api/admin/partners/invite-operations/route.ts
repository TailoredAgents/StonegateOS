import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  getDb,
  partnerInviteOperations,
  partnerLoginTokens,
  partnerUsers,
} from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { recoverStalePartnerInviteOperations } from "@/lib/partner-invite-recovery";
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
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";

const RECONCILIATION_ROUTE = "POST /api/admin/partners/invite-operations";
const RECONCILIATION_SCHEMA = z
  .object({
    operationId: z.string().uuid(),
    outcome: z.enum(["confirmed_sent", "confirmed_not_sent"]),
    confirmation: z.enum(["CONFIRM SENT", "CONFIRM NOT SENT"]),
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
    reason: z.string().trim().min(20).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedConfirmation =
      value.outcome === "confirmed_sent" ? "CONFIRM SENT" : "CONFIRM NOT SENT";
    if (value.confirmation !== expectedConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Type ${expectedConfirmation} exactly.`,
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
          "A confirmed send requires a provider operation ID and provider evidence.",
      });
    }
    if (
      value.outcome === "confirmed_not_sent" &&
      (value.providerOperationIds.length > 0 ||
        !["provider_no_matching_send", "provider_support_response"].includes(
          value.evidenceType,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message:
          "A confirmed non-send requires provider non-send evidence and no operation ID.",
      });
    }
  });

function requiredIntegerVersion(value: string | null): number {
  if (!value || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The latest invite-operation version is required.",
      { fieldErrors: { version: "Refresh the reconciliation queue." } },
    );
  }
  return Number(value);
}

function channelsMatch(
  expected: readonly string[],
  reviewed: readonly string[],
): boolean {
  const left = Array.from(new Set(expected)).sort();
  const right = Array.from(new Set(reviewed)).sort();
  return (
    left.length === right.length &&
    left.every((channel, index) => channel === right[index])
  );
}

function containsAcceptedProviderEvidence(
  evidence: readonly Record<string, unknown>[],
): boolean {
  return evidence.some((item) => item["state"] === "succeeded");
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "partners.invite");
  if (permissionError) return permissionError;
  if (new URL(request.url).searchParams.size !== 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_query",
        message: "This queue does not accept query parameters.",
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const db = getDb();
  const recovery = await recoverStalePartnerInviteOperations({
    db,
    limit: 25,
  });
  const rows = await db
    .select({
      id: partnerInviteOperations.id,
      orgContactId: partnerInviteOperations.orgContactId,
      partnerUserId: partnerInviteOperations.partnerUserId,
      userName: partnerUsers.name,
      userEmail: partnerUsers.email,
      operationKind: partnerInviteOperations.operationKind,
      initiatorType: partnerInviteOperations.initiatorType,
      requestedChannels: partnerInviteOperations.requestedChannels,
      correlationId: partnerInviteOperations.correlationId,
      actorMemberId: partnerInviteOperations.actorMemberId,
      actorLabel: partnerInviteOperations.actorLabel,
      state: partnerInviteOperations.state,
      version: partnerInviteOperations.version,
      providerOperationIds: partnerInviteOperations.providerOperationIds,
      providerEvidence: partnerInviteOperations.providerEvidence,
      failureCode: partnerInviteOperations.failureCode,
      failureDetail: partnerInviteOperations.failureDetail,
      requestedAt: partnerInviteOperations.requestedAt,
      dispatchedAt: partnerInviteOperations.dispatchedAt,
      reconciliationRequiredAt:
        partnerInviteOperations.reconciliationRequiredAt,
      updatedAt: partnerInviteOperations.updatedAt,
    })
    .from(partnerInviteOperations)
    .innerJoin(
      partnerUsers,
      eq(partnerUsers.id, partnerInviteOperations.partnerUserId),
    )
    .where(
      and(
        eq(partnerInviteOperations.state, "reconciliation_required"),
        isNull(partnerInviteOperations.resolvedAt),
      ),
    )
    .orderBy(desc(partnerInviteOperations.reconciliationRequiredAt))
    .limit(100);

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      truncated: rows.length === 100,
      recovery,
      items: rows.map((row) => ({
        ...row,
        requestedAt: row.requestedAt.toISOString(),
        dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
        reconciliationRequiredAt:
          row.reconciliationRequiredAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        providerOutcomePreserved: true,
        automaticRedispatchAllowed: false,
      })),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(
    request,
    {
      principalTypes: ["human"],
      requiredPermissions: ["partners.invite"],
      risk: "destructive",
      requiresIdempotency: true,
      auditAction: "partner_user.invite.reconciled",
    },
    {
      // Recording provider evidence performs no external send. Keeping this
      // available during a send freeze lets operators safely release guards;
      // any later send remains blocked by the external-send kill switch.
      ignoredPermissionKillSwitches: ["external_sends"],
    },
  );
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let candidate: unknown;
  try {
    candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1024,
      deadlineMs: 10_000,
    });
  } catch (error) {
    const message =
      error instanceof BoundedJsonRequestError
        ? error.message
        : "The reconciliation request is unreadable.";
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_invite_operation",
      code: "invalid",
      metadata: { boundary: "input", providerCalled: false },
    });
    return teamMutationExceptionResponse(
      new TeamMutationFailure("invalid", message),
      mutation,
    );
  }
  const parsed = RECONCILIATION_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_invite_operation",
      code: "invalid",
      metadata: { boundary: "input_validation", providerCalled: false },
    });
    return teamMutationExceptionResponse(
      new TeamMutationFailure(
        "invalid",
        "The provider evidence or typed confirmation is incomplete.",
        {
          fieldErrors: {
            confirmation: "Use the exact confirmation for the outcome.",
            evidence: "Attach conclusive evidence for every requested channel.",
            reason: "Explain the provider review in 20–1000 characters.",
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
      entityType: "partner_invite_operation",
      entityId: parsed.data.operationId,
      code: "invalid",
      metadata: { boundary: "expected_version", providerCalled: false },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: RECONCILIATION_ROUTE,
      entityType: "partner_invite_operation",
      entityId: parsed.data.operationId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const actorId = mutation.actor.id;
    if (!actorId || !mutation.actor.sessionId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified reconciliation reviewer is incomplete.",
      );
    }

    const completed = await db.transaction(async (tx) => {
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
          "This access-link operation is no longer awaiting reconciliation. Refresh the queue.",
        );
      }
      if (operation.version !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "This access-link operation changed after it was loaded. Refresh before reviewing it.",
          { fieldErrors: { version: "Refresh the reconciliation queue." } },
        );
      }
      if (
        !channelsMatch(
          operation.requestedChannels,
          parsed.data.reviewedChannels,
        )
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "Provider evidence must cover every channel requested by this operation.",
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
          containsAcceptedProviderEvidence(operation.providerEvidence))
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "Durable evidence already shows that a provider accepted this access link. It cannot be marked not sent.",
          {
            fieldErrors: {
              outcome: "Review the recorded provider acceptance.",
            },
          },
        );
      }
      if (
        parsed.data.providerOperationIds.some(
          (id) => knownProviderIds.size > 0 && !knownProviderIds.has(id),
        )
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The supplied provider operation ID conflicts with the durable provider evidence.",
          {
            fieldErrors: {
              providerOperationIds: "Verify the provider record.",
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
      const nextVersion = operation.version + 1;
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
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_invite_operation",
        entityId: operation.id,
        before: {
          state: operation.state,
          version: operation.version,
          reconciliationBlocked: true,
        },
        after: {
          state: operation.state,
          version: nextVersion,
          reconciliationBlocked: false,
          resolution: parsed.data.outcome,
        },
        metadata: {
          orgContactId: operation.orgContactId,
          partnerUserId: operation.partnerUserId,
          operationKind: operation.operationKind,
          outcome: parsed.data.outcome,
          evidenceType: parsed.data.evidenceType,
          reviewedChannels: parsed.data.reviewedChannels,
          providerOperationIds: parsed.data.providerOperationIds,
          originalProviderOutcomePreserved: true,
          providerCalled: false,
          automaticRedispatchAttempted: false,
          loginTokensInvalidatedCount: invalidatedTokens.length,
          reasonLength: parsed.data.reason.length,
        },
        committedAt: resolvedAt,
      });
      const [resolved] = await tx
        .update(partnerInviteOperations)
        .set({
          resolution: parsed.data.outcome,
          resolutionEvidence: parsed.data.reason,
          resolvedAt,
          resolvedBy: actorId,
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
          "Another reviewer resolved this operation first. Refresh the queue.",
        );
      }

      const result = teamMutationSuccessResult(
        mutation,
        {
          operationId: operation.id,
          outcome: parsed.data.outcome,
          operationVersion: resolved.version,
          guardReleased: true as const,
          providerCalled: false as const,
          tokensInvalidated: invalidatedTokens.length,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_invite_operation",
          entityId: operation.id,
          version: resolved.version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
        resolvedAt,
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
      entityType: "partner_invite_operation",
      entityId: parsed.data.operationId,
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
