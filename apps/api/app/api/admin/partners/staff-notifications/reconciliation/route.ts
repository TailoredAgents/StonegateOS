import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, staffNotificationOperations, teamMembers } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePermission } from "@/lib/permissions";
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

const ReconciliationSchema = z
  .object({
    operationId: z.string().uuid(),
    confirmation: z.literal("RECONCILE STAFF ALERT"),
    outcome: z.enum([
      "confirmed_sent",
      "confirmed_not_sent",
      "still_uncertain",
    ]),
    evidenceType: z.enum([
      "provider_message_record",
      "provider_no_matching_message",
      "provider_support_response",
      "operator_investigation",
    ]),
    providerOperationId: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .nullable()
      .optional(),
    reason: z.string().trim().min(20).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.outcome === "confirmed_sent" &&
      (!value.providerOperationId ||
        !["provider_message_record", "provider_support_response"].includes(
          value.evidenceType,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationId"],
        message:
          "Confirmed delivery requires the reviewed provider message ID and provider evidence.",
      });
    }
    if (
      value.outcome === "confirmed_not_sent" &&
      !["provider_no_matching_message", "provider_support_response"].includes(
        value.evidenceType,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message:
          "Confirmed non-delivery requires a provider search or provider support response.",
      });
    }
    if (value.outcome === "confirmed_not_sent" && value.providerOperationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationId"],
        message:
          "Do not add a provider message ID when the provider confirmed no message was sent.",
      });
    }
    if (
      value.outcome === "still_uncertain" &&
      value.providerOperationId &&
      !["provider_message_record", "provider_support_response"].includes(
        value.evidenceType,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message:
          "A newly supplied provider message ID requires provider evidence.",
      });
    }
  });

function maskRecipient(value: string): string {
  const suffix = value.slice(-4);
  return suffix.length === 4 ? `••••${suffix}` : "unavailable";
}

function requireTimestampVersion(value: string | null): string {
  if (value === null || value === "*") {
    throw new TeamMutationFailure(
      "invalid",
      "The latest staff-alert version is required.",
      { fieldErrors: { version: "Refresh the reconciliation queue." } },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TeamMutationFailure(
      "invalid",
      "The staff-alert version is malformed.",
      { fieldErrors: { version: "Refresh the reconciliation queue." } },
    );
  }
  return value;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authorizationError = await requirePermission(request, "partners.write");
  if (authorizationError) return authorizationError;

  const db = getDb();
  const rows = await db
    .select({
      id: staffNotificationOperations.id,
      appointmentId: staffNotificationOperations.appointmentId,
      contactId: staffNotificationOperations.contactId,
      kind: staffNotificationOperations.kind,
      channel: staffNotificationOperations.channel,
      recipientAddress: staffNotificationOperations.recipientAddress,
      body: staffNotificationOperations.body,
      providerRequestKey: staffNotificationOperations.providerRequestKey,
      recipientTeamMemberId: staffNotificationOperations.recipientTeamMemberId,
      recipientLabel: teamMembers.name,
      state: staffNotificationOperations.state,
      provider: staffNotificationOperations.provider,
      providerOperationId: staffNotificationOperations.providerOperationId,
      deliveryCertainty: staffNotificationOperations.deliveryCertainty,
      failureCode: staffNotificationOperations.failureCode,
      attemptCount: staffNotificationOperations.attemptCount,
      dispatchedAt: staffNotificationOperations.dispatchedAt,
      uncertaintyAt: staffNotificationOperations.uncertaintyAt,
      failedAt: staffNotificationOperations.failedAt,
      createdAt: staffNotificationOperations.createdAt,
      updatedAt: staffNotificationOperations.updatedAt,
    })
    .from(staffNotificationOperations)
    .leftJoin(
      teamMembers,
      eq(staffNotificationOperations.recipientTeamMemberId, teamMembers.id),
    )
    .where(eq(staffNotificationOperations.state, "reconciliation_required"))
    .orderBy(desc(staffNotificationOperations.updatedAt))
    .limit(101);
  const truncated = rows.length > 100;
  const visibleRows = rows.slice(0, 100);

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      truncated,
      items: visibleRows.map(
        ({ recipientAddress, body, updatedAt, ...row }) => ({
          ...row,
          recipientAddressMasked: maskRecipient(recipientAddress),
          bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
          bodyLength: body.length,
          version: updatedAt.toISOString(),
          providerEvidenceStatus: "unverified_operator_review_required",
          redispatchAllowed: false,
        }),
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "partner.staff_notification.reconciled",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let rawPayload: unknown;
  try {
    rawPayload = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : new TeamMutationFailure("invalid", "The request body is invalid.");
    await recordTeamMutationFailure(mutation, {
      entityType: "staff_notification_operation",
      code: "invalid",
      metadata: { boundary: "bounded_input", providerCalled: false },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const parsed = ReconciliationSchema.safeParse(rawPayload);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "staff_notification_operation",
      code: "invalid",
      metadata: { boundary: "input_validation", providerCalled: false },
    });
    return teamMutationExceptionResponse(
      new TeamMutationFailure(
        "invalid",
        "The reconciliation decision or evidence is incomplete.",
        {
          fieldErrors: {
            confirmation: 'Type "RECONCILE STAFF ALERT" exactly.',
            evidence: "Provide the exact provider evidence you reviewed.",
            reason: "Explain the review in at least 20 characters.",
          },
        },
      ),
      mutation,
    );
  }

  let expectedVersion: string;
  try {
    expectedVersion = requireTimestampVersion(mutation.expectedVersion);
  } catch (error) {
    await recordTeamMutationFailure(mutation, {
      entityType: "staff_notification_operation",
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
      route: "POST /api/admin/partners/staff-notifications/reconciliation",
      entityType: "staff_notification_operation",
      entityId: parsed.data.operationId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const completed = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.id, parsed.data.operationId))
        .for("update")
        .limit(1);
      if (!operation) {
        throw new TeamMutationFailure(
          "conflict",
          "This staff alert no longer exists. Refresh the queue.",
        );
      }
      if (operation.state !== "reconciliation_required") {
        throw new TeamMutationFailure(
          "conflict",
          "This staff alert is no longer awaiting reconciliation. Refresh the queue.",
        );
      }
      if (operation.updatedAt.toISOString() !== expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "This staff alert changed after it was loaded. Refresh before reviewing it.",
          { fieldErrors: { version: "Refresh the reconciliation queue." } },
        );
      }
      if (
        parsed.data.outcome === "confirmed_not_sent" &&
        operation.providerOperationId &&
        parsed.data.evidenceType !== "provider_support_response"
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This alert has a provider message ID. Provider support evidence is required before it can be marked not sent.",
          {
            fieldErrors: {
              evidenceType: "Use the reviewed provider support response.",
            },
          },
        );
      }
      if (
        parsed.data.providerOperationId &&
        operation.providerOperationId &&
        parsed.data.providerOperationId !== operation.providerOperationId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The reviewed provider message ID conflicts with the ID already bound to this alert. Refresh and verify the provider record.",
          {
            fieldErrors: {
              providerOperationId: "Use the bound provider message ID.",
            },
          },
        );
      }

      const reviewedAt = new Date(
        Math.max(Date.now(), operation.updatedAt.getTime() + 1),
      );
      const providerOperationId =
        parsed.data.providerOperationId ?? operation.providerOperationId;
      const nextState =
        parsed.data.outcome === "confirmed_sent"
          ? ("succeeded" as const)
          : parsed.data.outcome === "confirmed_not_sent"
            ? ("failed" as const)
            : ("reconciliation_required" as const);
      const nextDeliveryCertainty =
        parsed.data.outcome === "confirmed_sent"
          ? "operator_confirmed_sent"
          : parsed.data.outcome === "confirmed_not_sent"
            ? "operator_confirmed_not_sent"
            : "uncertain";

      const [updated] = await tx
        .update(staffNotificationOperations)
        .set({
          state: nextState,
          providerOperationId,
          deliveryCertainty: nextDeliveryCertainty,
          retryable: false,
          failureCode:
            parsed.data.outcome === "confirmed_sent"
              ? null
              : parsed.data.outcome === "confirmed_not_sent"
                ? "operator_confirmed_not_sent"
                : operation.failureCode,
          succeededAt:
            parsed.data.outcome === "confirmed_sent" ? reviewedAt : null,
          failedAt:
            parsed.data.outcome === "confirmed_sent"
              ? null
              : (operation.failedAt ?? reviewedAt),
          updatedAt: reviewedAt,
        })
        .where(
          and(
            eq(staffNotificationOperations.id, operation.id),
            eq(staffNotificationOperations.state, "reconciliation_required"),
            eq(staffNotificationOperations.updatedAt, operation.updatedAt),
          ),
        )
        .returning({
          state: staffNotificationOperations.state,
          updatedAt: staffNotificationOperations.updatedAt,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "Another reviewer changed this staff alert first. Refresh the queue.",
        );
      }

      const reasonHash = createHash("sha256")
        .update(parsed.data.reason, "utf8")
        .digest("hex");
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "staff_notification_operation",
        entityId: operation.id,
        providerOperationId: providerOperationId ?? undefined,
        before: {
          state: operation.state,
          version: operation.updatedAt.toISOString(),
          deliveryCertainty: operation.deliveryCertainty,
          retryable: operation.retryable,
        },
        after: {
          state: updated.state,
          version: updated.updatedAt.toISOString(),
          deliveryCertainty: nextDeliveryCertainty,
          retryable: false,
        },
        metadata: {
          appointmentId: operation.appointmentId,
          contactId: operation.contactId,
          kind: operation.kind,
          outcome: parsed.data.outcome,
          evidenceType: parsed.data.evidenceType,
          providerEvidenceSource: "operator_supplied",
          originalProviderOutcomePreserved: true,
          reasonRecorded: true,
          reasonLength: parsed.data.reason.length,
          reasonHash,
          providerCalled: false,
          redispatchEnqueued: false,
          redispatchAllowed: false,
        },
        committedAt: reviewedAt,
      });

      const data = {
        operationId: operation.id,
        outcome: parsed.data.outcome,
        state: updated.state,
        version: updated.updatedAt.toISOString(),
        providerEvidenceSource: "operator_supplied" as const,
        originalProviderOutcomePreserved: true as const,
        providerCalled: false as const,
        redispatchEnqueued: false as const,
        redispatchAllowed: false as const,
      };
      const result = teamMutationSuccessResult(mutation, data, {
        committedAt: audit.committedAt,
        auditEventId: audit.auditEventId,
        entityType: "staff_notification_operation",
        entityId: operation.id,
        version: updated.updatedAt.toISOString(),
        providerOperationId: providerOperationId ?? undefined,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
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
      entityType: "staff_notification_operation",
      entityId: parsed.data.operationId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        boundary: "staff_notification_reconciliation_commit",
        providerCalled: false,
        redispatchEnqueued: false,
        originalProviderOutcomePreserved: true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
