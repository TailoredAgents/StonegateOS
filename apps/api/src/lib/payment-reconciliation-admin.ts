import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  type DatabaseClient,
  paymentAttempts,
  paymentProviderEvents,
  paymentRefunds,
  payments,
} from "@/db";
import { canDismissSquareAttemptAfterReview } from "@/lib/payment-ledger";
import { resolveLegacyStripePaymentInTransaction } from "@/lib/payment-reconciliation";
import {
  nextPaymentReconciliationVersion,
  PAYMENT_RECONCILIATION_CONFIRMATIONS,
  type PaymentReconciliationOperation,
  type PaymentReconciliationOutcome,
  squareProviderEventVersion,
  summarizeSquareRecordResult,
  summarizeSquareSweep,
} from "@/lib/payment-reconciliation-safety";
import {
  canReclaimSquareProviderEvent,
  completeSquareProviderEvent,
  reconcilePendingSquareAttempts,
  reconcileSquareAttempt,
  reconcileSquarePaymentEvent,
  reconcileSquareRefundEvent,
  SQUARE_PROVIDER_EVENT_LEASE_MS,
} from "@/lib/square-payments";
import { SquareApiError } from "@/lib/square-client";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationSuccessAuditInput,
  type TeamMutationTransaction,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const providerId = z.string().trim().min(1).max(200);
const reviewNote = z.string().trim().min(3).max(500);

export const PaymentReconciliationRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("run_square_reconciliation_sweep"),
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.run_square_reconciliation_sweep,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("retry_square_attempt"),
        attemptId: z.string().uuid(),
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.retry_square_attempt,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("dismiss_square_attempt"),
        attemptId: z.string().uuid(),
        reviewNote,
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.dismiss_square_attempt,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("retry_square_event"),
        eventId: z.string().uuid(),
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.retry_square_event,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("retry_square_payment"),
        paymentId: z.string().uuid(),
        providerPaymentId: providerId,
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.retry_square_payment,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("retry_square_refund"),
        refundId: z.string().uuid(),
        providerRefundId: providerId,
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.retry_square_refund,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("resolve_stripe_payment"),
        paymentId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        jobAmountCents: z.number().int().nonnegative().max(100_000_000),
        tipCents: z.number().int().nonnegative().max(10_000_000),
        reviewNote,
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.resolve_stripe_payment,
        ),
      })
      .strict(),
    z
      .object({
        operation: z.literal("acknowledge_refund_impact"),
        refundId: z.string().uuid(),
        reviewNote,
        confirmation: z.literal(
          PAYMENT_RECONCILIATION_CONFIRMATIONS.acknowledge_refund_impact,
        ),
      })
      .strict(),
  ],
);

export type PaymentReconciliationRequest = z.infer<
  typeof PaymentReconciliationRequestSchema
>;

export type PaymentReconciliationMutationData = {
  operation: PaymentReconciliationOperation;
  outcome: PaymentReconciliationOutcome;
  message: string;
  providerEffect: "none" | "read_only";
  targetId: string | null;
  version?: string;
  result: unknown;
};

type ProviderReadRequest = Extract<
  PaymentReconciliationRequest,
  {
    operation:
      | "run_square_reconciliation_sweep"
      | "retry_square_attempt"
      | "retry_square_event"
      | "retry_square_payment"
      | "retry_square_refund";
  }
>;

type OwnerResolutionRequest = Exclude<
  PaymentReconciliationRequest,
  ProviderReadRequest
>;

const PROVIDER_OPERATION_LEASE_MS = 10 * 60 * 1_000;
const PROVIDER_LOCK_SCOPE = "payment-reconciliation:square";

function providerObjectId(
  payload: Record<string, unknown> | null,
): string | null {
  const value = payload?.["objectId"];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function mutationTarget(input: PaymentReconciliationRequest): {
  entityType: string;
  entityId: string;
} {
  switch (input.operation) {
    case "run_square_reconciliation_sweep":
      return { entityType: "payment_reconciliation", entityId: "square" };
    case "retry_square_attempt":
    case "dismiss_square_attempt":
      return { entityType: "payment_attempt", entityId: input.attemptId };
    case "retry_square_event":
      return { entityType: "payment_provider_event", entityId: input.eventId };
    case "retry_square_payment":
    case "resolve_stripe_payment":
      return { entityType: "payment", entityId: input.paymentId };
    case "retry_square_refund":
    case "acknowledge_refund_impact":
      return { entityType: "payment_refund", entityId: input.refundId };
  }
}

function isProviderReadRequest(
  input: PaymentReconciliationRequest,
): input is ProviderReadRequest {
  return [
    "run_square_reconciliation_sweep",
    "retry_square_attempt",
    "retry_square_event",
    "retry_square_payment",
    "retry_square_refund",
  ].includes(input.operation);
}

function requireExpectedVersion(
  mutation: TeamMutationContext,
  operation: PaymentReconciliationOperation,
): void {
  if (operation === "run_square_reconciliation_sweep") return;
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    throw new TeamMutationFailure(
      "invalid",
      "The latest reconciliation record version is required.",
      {
        fieldErrors: {
          version: "Refresh the payment review list and try again.",
        },
      },
    );
  }
}

function firstResultRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return first && typeof first === "object"
      ? (first as Record<string, unknown>)
      : null;
  }
  if (value && typeof value === "object") {
    const rows = (value as Record<string, unknown>)["rows"];
    if (Array.isArray(rows)) {
      const first: unknown = rows[0];
      return first && typeof first === "object"
        ? (first as Record<string, unknown>)
        : null;
    }
  }
  return null;
}

async function acquireProviderReconciliationLock(
  tx: TeamMutationTransaction,
): Promise<void> {
  const lockResult: unknown = await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${PROVIDER_LOCK_SCOPE}, 71)) as locked`,
  );
  if (firstResultRow(lockResult)?.["locked"] !== true) {
    throw new TeamMutationFailure(
      "conflict",
      "Another Square reconciliation check is already running. Wait for it to finish, then refresh.",
      { retryable: true, retryAfter: "3" },
    );
  }
}

async function completeReconciliationMutation(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  data: PaymentReconciliationMutationData,
  auditInput: TeamMutationSuccessAuditInput,
) {
  const audit = await mutation.audit.insertSuccess(tx, auditInput);
  const result = teamMutationSuccessResult(mutation, data, {
    auditEventId: audit.auditEventId,
    committedAt: audit.committedAt,
    entityType: auditInput.entityType,
    entityId: auditInput.entityId ?? undefined,
    ...(data.version ? { version: data.version } : {}),
    ...(auditInput.providerOperationId
      ? { providerOperationId: auditInput.providerOperationId }
      : {}),
  });
  await completeTeamMutationIdempotency(tx, mutation, claim, result, 200);
  return result;
}

type ProviderEventRetryResult =
  | {
      kind: "retried";
      eventId: string;
      providerEventId: string;
      providerObjectId: string;
      eventType: string;
      result: {
        paymentId: string | null;
        paymentAttemptId: string | null;
        status: "processed" | "needs_review";
      };
    }
  | { kind: "not_found" }
  | { kind: "not_retryable"; status: string }
  | { kind: "unsupported"; eventType: string }
  | { kind: "object_id_missing"; eventType: string }
  | { kind: "lease_lost" }
  | { kind: "failed"; eventId: string; error: string };

async function retrySquareProviderEvent(
  db: DatabaseClient,
  eventId: string,
): Promise<ProviderEventRetryResult> {
  const [event] = await db
    .select({
      id: paymentProviderEvents.id,
      provider: paymentProviderEvents.provider,
      providerEventId: paymentProviderEvents.providerEventId,
      eventType: paymentProviderEvents.eventType,
      processingStatus: paymentProviderEvents.processingStatus,
      payload: paymentProviderEvents.payload,
      receivedAt: paymentProviderEvents.receivedAt,
      processedAt: paymentProviderEvents.processedAt,
    })
    .from(paymentProviderEvents)
    .where(eq(paymentProviderEvents.id, eventId))
    .limit(1);
  if (!event || event.provider !== "square") return { kind: "not_found" };

  const retryable =
    event.processingStatus === "needs_review" ||
    canReclaimSquareProviderEvent({
      processingStatus: event.processingStatus,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
    });
  if (!retryable) {
    return { kind: "not_retryable", status: event.processingStatus };
  }

  const isPaymentEvent =
    event.eventType === "payment.created" ||
    event.eventType === "payment.updated";
  const isRefundEvent =
    event.eventType === "refund.created" ||
    event.eventType === "refund.updated";
  if (!isPaymentEvent && !isRefundEvent) {
    return { kind: "unsupported", eventType: event.eventType };
  }
  const objectId = providerObjectId(event.payload);
  if (!objectId) {
    return { kind: "object_id_missing", eventType: event.eventType };
  }

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS);
  const retryEligibility =
    event.processingStatus === "failed" ||
    event.processingStatus === "needs_review"
      ? eq(paymentProviderEvents.processingStatus, event.processingStatus)
      : event.processedAt
        ? and(
            eq(paymentProviderEvents.processingStatus, event.processingStatus),
            lte(paymentProviderEvents.processedAt, staleCutoff),
          )
        : and(
            eq(paymentProviderEvents.processingStatus, event.processingStatus),
            isNull(paymentProviderEvents.processedAt),
            lte(paymentProviderEvents.receivedAt, staleCutoff),
          );
  const leaseId = randomUUID();
  const [claimed] = await db
    .update(paymentProviderEvents)
    .set({
      processingStatus: "processing",
      paymentId: null,
      paymentAttemptId: null,
      payload: {
        ...(event.payload ?? {}),
        processingLeaseId: leaseId,
        ownerRetryStartedAt: now.toISOString(),
      },
      processedAt: now,
      error: null,
    })
    .where(and(eq(paymentProviderEvents.id, event.id), retryEligibility))
    .returning({ id: paymentProviderEvents.id });
  if (!claimed) return { kind: "lease_lost" };

  try {
    const result = isPaymentEvent
      ? await reconcileSquarePaymentEvent(objectId)
      : await reconcileSquareRefundEvent(objectId);
    const completed = await completeSquareProviderEvent({
      eventId: event.id,
      leaseId,
      status: result.status === "needs_review" ? "needs_review" : "processed",
      paymentId: result.paymentId,
      paymentAttemptId: result.paymentAttemptId,
    });
    if (!completed) return { kind: "lease_lost" };
    return {
      kind: "retried",
      eventId: event.id,
      providerEventId: event.providerEventId,
      providerObjectId: objectId,
      eventType: event.eventType,
      result,
    };
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.slice(0, 1_000)
        : "square_event_retry_failed";
    await completeSquareProviderEvent({
      eventId: event.id,
      leaseId,
      status: "failed",
      error: detail,
    });
    return { kind: "failed", eventId: event.id, error: detail };
  }
}

export function paymentReconciliationProviderFailure(
  error: unknown,
): TeamMutationFailure {
  if (error instanceof TeamMutationFailure) return error;

  if (error instanceof SquareApiError && error.status === 429) {
    return new TeamMutationFailure(
      "rate_limited",
      "Square is temporarily limiting reconciliation checks. No charge or refund was initiated. Wait before retrying.",
      { retryable: true },
    );
  }

  const errorName = error instanceof Error ? error.name : "";
  const errorMessage =
    error instanceof Error ? error.message.trim().toLowerCase() : "";
  if (
    (error instanceof SquareApiError &&
      (error.status === 408 || error.status === 504)) ||
    errorName === "TimeoutError" ||
    errorName === "AbortError" ||
    errorMessage.includes("timed out") ||
    errorMessage.includes("timeout")
  ) {
    return new TeamMutationFailure(
      "timeout",
      "The Square reconciliation check timed out. Some local records may have refreshed, but no charge or refund was initiated. Refresh before retrying.",
      { retryable: true },
    );
  }

  return new TeamMutationFailure(
    "provider_failed",
    "The Square check did not complete. Some local reconciliation records may have refreshed, but no charge or refund was initiated. Refresh before retrying.",
    { retryable: true },
  );
}

async function executeProviderRead(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  input: ProviderReadRequest,
) {
  await extendTeamMutationIdempotencyLease(
    db,
    mutation,
    claim,
    PROVIDER_OPERATION_LEASE_MS,
  );

  let providerStarted = false;
  let providerReturned = false;
  try {
    return await db.transaction(async (tx) => {
      await acquireProviderReconciliationLock(tx);

      if (input.operation === "run_square_reconciliation_sweep") {
        providerStarted = true;
        const rawResult = await reconcilePendingSquareAttempts();
        providerReturned = true;
        const summary = summarizeSquareSweep(rawResult);
        const data: PaymentReconciliationMutationData = {
          operation: input.operation,
          ...summary,
          providerEffect: "read_only",
          targetId: null,
          result: rawResult,
        };
        return completeReconciliationMutation(tx, mutation, claim, data, {
          entityType: "payment_reconciliation",
          entityId: null,
          before: null,
          after: {
            outcome: summary.outcome,
            pending: rawResult.pending,
            needsReview: rawResult.needsReview,
            unmatched: rawResult.unmatched,
          },
          metadata: {
            surface: "team.owner.payments",
            operation: input.operation,
            provider: "square",
            providerEffect: "read_only",
            counts: rawResult,
          },
        });
      }

      if (input.operation === "retry_square_attempt") {
        const [before] = await tx
          .select({
            id: paymentAttempts.id,
            provider: paymentAttempts.provider,
            status: paymentAttempts.status,
            updatedAt: paymentAttempts.updatedAt,
          })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, input.attemptId))
          .limit(1);
        if (!before || before.provider !== "square") {
          throw new TeamMutationFailure(
            "invalid",
            "The Square payment attempt was not found.",
            { status: 404 },
          );
        }
        assertTeamMutationExpectedVersion(mutation, before.updatedAt);
        providerStarted = true;
        const rawResult = await reconcileSquareAttempt({
          attemptId: before.id,
        });
        providerReturned = true;
        const summary = summarizeSquareRecordResult({
          kind: "attempt",
          status: rawResult.status,
        });
        const [after] = await tx
          .select({
            status: paymentAttempts.status,
            updatedAt: paymentAttempts.updatedAt,
          })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, before.id))
          .limit(1);
        const version = (after?.updatedAt ?? before.updatedAt).toISOString();
        const data: PaymentReconciliationMutationData = {
          operation: input.operation,
          ...summary,
          providerEffect: "read_only",
          targetId: before.id,
          version,
          result: rawResult,
        };
        return completeReconciliationMutation(tx, mutation, claim, data, {
          entityType: "payment_attempt",
          entityId: before.id,
          before: {
            status: before.status,
            version: before.updatedAt.toISOString(),
          },
          after: { status: after?.status ?? rawResult.status, version },
          metadata: {
            surface: "team.owner.payments",
            operation: input.operation,
            provider: "square",
            providerEffect: "read_only",
            reconciliationOutcome: summary.outcome,
          },
          providerOperationId:
            "providerPaymentId" in rawResult
              ? (rawResult.providerPaymentId ?? null)
              : null,
        });
      }

      if (input.operation === "retry_square_event") {
        const [before] = await tx
          .select({
            id: paymentProviderEvents.id,
            provider: paymentProviderEvents.provider,
            providerEventId: paymentProviderEvents.providerEventId,
            eventType: paymentProviderEvents.eventType,
            processingStatus: paymentProviderEvents.processingStatus,
            payload: paymentProviderEvents.payload,
            receivedAt: paymentProviderEvents.receivedAt,
            processedAt: paymentProviderEvents.processedAt,
          })
          .from(paymentProviderEvents)
          .where(eq(paymentProviderEvents.id, input.eventId))
          .limit(1);
        if (!before || before.provider !== "square") {
          throw new TeamMutationFailure(
            "invalid",
            "The Square provider event was not found.",
            { status: 404 },
          );
        }
        assertTeamMutationExpectedVersion(
          mutation,
          squareProviderEventVersion(before),
        );
        const eventRetryable =
          before.processingStatus === "needs_review" ||
          canReclaimSquareProviderEvent({
            processingStatus: before.processingStatus,
            receivedAt: before.receivedAt,
            processedAt: before.processedAt,
          });
        if (!eventRetryable) {
          throw new TeamMutationFailure(
            "conflict",
            `The provider event is ${before.processingStatus} and cannot be retried. Refresh the review list.`,
          );
        }
        const supportedEvent = [
          "payment.created",
          "payment.updated",
          "refund.created",
          "refund.updated",
        ].includes(before.eventType);
        if (!supportedEvent) {
          throw new TeamMutationFailure(
            "conflict",
            `The ${before.eventType} event has no automatic reconciliation handler.`,
          );
        }
        if (!providerObjectId(before.payload)) {
          throw new TeamMutationFailure(
            "conflict",
            "The saved provider event has no Square object ID and must remain in manual review.",
          );
        }
        providerStarted = true;
        const rawResult = await retrySquareProviderEvent(db, before.id);
        providerReturned = true;
        if (rawResult.kind === "not_retryable") {
          throw new TeamMutationFailure(
            "conflict",
            `The provider event is ${rawResult.status} and cannot be retried. Refresh the review list.`,
          );
        }
        if (rawResult.kind === "unsupported") {
          throw new TeamMutationFailure(
            "conflict",
            `The ${rawResult.eventType} event has no automatic reconciliation handler.`,
          );
        }
        if (rawResult.kind === "object_id_missing") {
          throw new TeamMutationFailure(
            "conflict",
            "The saved provider event has no Square object ID and must remain in manual review.",
          );
        }
        if (rawResult.kind === "not_found" || rawResult.kind === "lease_lost") {
          throw new TeamMutationFailure(
            "conflict",
            "The provider event changed while the retry was starting. Refresh and review its current state.",
            { retryable: true },
          );
        }

        const providerStatus =
          rawResult.kind === "failed" ? "failed" : rawResult.result.status;
        const summary = summarizeSquareRecordResult({
          kind: "event",
          status: providerStatus,
        });
        const [after] = await tx
          .select({
            processingStatus: paymentProviderEvents.processingStatus,
            receivedAt: paymentProviderEvents.receivedAt,
            processedAt: paymentProviderEvents.processedAt,
          })
          .from(paymentProviderEvents)
          .where(eq(paymentProviderEvents.id, before.id))
          .limit(1);
        if (!after) {
          throw new TeamMutationFailure(
            "internal",
            "The provider event disappeared after it was checked.",
          );
        }
        const version = squareProviderEventVersion(after);
        const data: PaymentReconciliationMutationData = {
          operation: input.operation,
          ...summary,
          providerEffect: "read_only",
          targetId: before.id,
          version,
          result: rawResult,
        };
        return completeReconciliationMutation(tx, mutation, claim, data, {
          entityType: "payment_provider_event",
          entityId: before.id,
          before: {
            processingStatus: before.processingStatus,
            version: squareProviderEventVersion(before),
          },
          after: { processingStatus: after.processingStatus, version },
          metadata: {
            surface: "team.owner.payments",
            operation: input.operation,
            provider: "square",
            providerEffect: "read_only",
            eventType: before.eventType,
            providerObjectIdPresent: Boolean(providerObjectId(before.payload)),
            providerOutcome: providerStatus,
            reconciliationOutcome: summary.outcome,
          },
          providerOperationId: before.providerEventId,
        });
      }

      if (input.operation === "retry_square_payment") {
        const [before] = await tx
          .select({
            id: payments.id,
            provider: payments.provider,
            providerPaymentId: payments.providerPaymentId,
            canonicalStatus: payments.canonicalStatus,
            providerStatus: payments.providerStatus,
            updatedAt: payments.updatedAt,
          })
          .from(payments)
          .where(eq(payments.id, input.paymentId))
          .limit(1);
        if (
          !before ||
          before.provider !== "square" ||
          before.providerPaymentId !== input.providerPaymentId
        ) {
          throw new TeamMutationFailure(
            "invalid",
            "The local Square payment and provider ID no longer match. Refresh before retrying.",
            { status: 404 },
          );
        }
        assertTeamMutationExpectedVersion(mutation, before.updatedAt);
        providerStarted = true;
        const rawResult = await reconcileSquarePaymentEvent(
          before.providerPaymentId,
        );
        providerReturned = true;
        const summary = summarizeSquareRecordResult({
          kind: "payment",
          status: rawResult.status,
        });
        const [after] = await tx
          .select({
            canonicalStatus: payments.canonicalStatus,
            providerStatus: payments.providerStatus,
            updatedAt: payments.updatedAt,
          })
          .from(payments)
          .where(eq(payments.id, before.id))
          .limit(1);
        const version = (after?.updatedAt ?? before.updatedAt).toISOString();
        const data: PaymentReconciliationMutationData = {
          operation: input.operation,
          ...summary,
          providerEffect: "read_only",
          targetId: before.id,
          version,
          result: rawResult,
        };
        return completeReconciliationMutation(tx, mutation, claim, data, {
          entityType: "payment",
          entityId: before.id,
          before: {
            canonicalStatus: before.canonicalStatus,
            providerStatus: before.providerStatus,
            version: before.updatedAt.toISOString(),
          },
          after: {
            canonicalStatus: after?.canonicalStatus ?? null,
            providerStatus: after?.providerStatus ?? null,
            version,
          },
          metadata: {
            surface: "team.owner.payments",
            operation: input.operation,
            provider: "square",
            providerEffect: "read_only",
            reconciliationOutcome: summary.outcome,
          },
          providerOperationId: before.providerPaymentId,
        });
      }

      const [before] = await tx
        .select({
          id: paymentRefunds.id,
          provider: paymentRefunds.provider,
          providerRefundId: paymentRefunds.providerRefundId,
          canonicalStatus: paymentRefunds.canonicalStatus,
          providerStatus: paymentRefunds.providerStatus,
          updatedAt: paymentRefunds.updatedAt,
        })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, input.refundId))
        .limit(1);
      if (
        !before ||
        before.provider !== "square" ||
        before.providerRefundId !== input.providerRefundId
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The local Square refund and provider ID no longer match. Refresh before retrying.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, before.updatedAt);
      providerStarted = true;
      const rawResult = await reconcileSquareRefundEvent(
        before.providerRefundId,
      );
      providerReturned = true;
      const summary = summarizeSquareRecordResult({
        kind: "refund",
        status: rawResult.status,
      });
      const [after] = await tx
        .select({
          canonicalStatus: paymentRefunds.canonicalStatus,
          providerStatus: paymentRefunds.providerStatus,
          updatedAt: paymentRefunds.updatedAt,
        })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, before.id))
        .limit(1);
      const version = (after?.updatedAt ?? before.updatedAt).toISOString();
      const data: PaymentReconciliationMutationData = {
        operation: input.operation,
        ...summary,
        providerEffect: "read_only",
        targetId: before.id,
        version,
        result: rawResult,
      };
      return completeReconciliationMutation(tx, mutation, claim, data, {
        entityType: "payment_refund",
        entityId: before.id,
        before: {
          canonicalStatus: before.canonicalStatus,
          providerStatus: before.providerStatus,
          version: before.updatedAt.toISOString(),
        },
        after: {
          canonicalStatus: after?.canonicalStatus ?? null,
          providerStatus: after?.providerStatus ?? null,
          version,
        },
        metadata: {
          surface: "team.owner.payments",
          operation: input.operation,
          provider: "square",
          providerEffect: "read_only",
          reconciliationOutcome: summary.outcome,
        },
        providerOperationId: before.providerRefundId,
      });
    });
  } catch (error) {
    if (!providerStarted) throw error;
    if (!providerReturned) {
      throw paymentReconciliationProviderFailure(error);
    }
    throw new TeamMutationFailure(
      "internal",
      "Square may have refreshed local reconciliation records, but the audit receipt could not be confirmed. Refresh the list before retrying.",
      { retryable: true },
    );
  }
}

function legacyStripeFailure(code: string): TeamMutationFailure {
  const messages: Record<string, string> = {
    payment_not_found: "The historical Stripe payment was not found.",
    appointment_not_found: "The selected appointment was not found.",
    stripe_payment_required: "Only a Stripe payment can use this resolution.",
    stripe_payment_not_in_review:
      "This Stripe payment is no longer waiting for owner review.",
    stripe_payment_not_completed:
      "The Stripe provider record is not financially completed.",
    stripe_payment_already_attached_elsewhere:
      "This Stripe payment is already attached to another appointment.",
    owner_review_note_required: "An owner review reason is required.",
    stripe_allocation_invalid: "The job and tip allocation is invalid.",
    stripe_allocation_mismatch:
      "The job and tip allocation must equal the provider payment total.",
    appointment_final_total_required:
      "Set the appointment final total before resolving this payment.",
    appointment_has_other_payment_review:
      "Resolve the appointment's other payment review items first.",
    stripe_job_amount_exceeds_balance:
      "This allocation would pay more than the appointment's remaining balance.",
    payment_changed:
      "The payment changed while its appointment link was being updated. Refresh the review list.",
  };
  const notFound =
    code === "payment_not_found" || code === "appointment_not_found";
  return new TeamMutationFailure(
    notFound ? "invalid" : "conflict",
    messages[code] ?? "The Stripe payment could not be safely resolved.",
    { status: notFound ? 404 : 409 },
  );
}

async function executeOwnerResolution(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  input: OwnerResolutionRequest,
) {
  return db.transaction(async (tx) => {
    if (input.operation === "dismiss_square_attempt") {
      await acquireProviderReconciliationLock(tx);
      const [before] = await tx
        .select({
          id: paymentAttempts.id,
          appointmentId: paymentAttempts.appointmentId,
          provider: paymentAttempts.provider,
          status: paymentAttempts.status,
          metadata: paymentAttempts.metadata,
          updatedAt: paymentAttempts.updatedAt,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .limit(1)
        .for("update");
      if (!before || before.provider !== "square") {
        throw new TeamMutationFailure(
          "invalid",
          "The Square payment attempt was not found.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, before.updatedAt);
      if (!canDismissSquareAttemptAfterReview(before.status)) {
        throw new TeamMutationFailure(
          "conflict",
          `A ${before.status.replace(/_/gu, " ")} attempt cannot be dismissed. Refresh and review its current state.`,
        );
      }

      const now = nextPaymentReconciliationVersion(before.updatedAt);
      const [updated] = await tx
        .update(paymentAttempts)
        .set({
          status: "canceled",
          resolvedAt: now,
          errorCode: "owner_dismissed_after_provider_review",
          errorMessage: input.reviewNote,
          metadata: {
            ...(before.metadata ?? {}),
            ownerDismissedAt: now.toISOString(),
            ownerDismissedBy:
              mutation.actor.id ?? mutation.actor.label ?? "unknown",
            ownerDismissalReviewNote: input.reviewNote,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAttempts.id, before.id),
            eq(paymentAttempts.status, before.status),
            eq(paymentAttempts.updatedAt, before.updatedAt),
          ),
        )
        .returning({ id: paymentAttempts.id });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment attempt changed while it was being dismissed. Refresh and try again.",
          { retryable: true },
        );
      }

      const data: PaymentReconciliationMutationData = {
        operation: input.operation,
        outcome: "resolved",
        message:
          "The attempt was dismissed after the no-charge confirmation. The reason and actor are recorded.",
        providerEffect: "none",
        targetId: before.id,
        version: now.toISOString(),
        result: {
          attemptId: before.id,
          appointmentId: before.appointmentId,
          previousStatus: before.status,
          status: "canceled",
        },
      };
      return completeReconciliationMutation(tx, mutation, claim, data, {
        entityType: "payment_attempt",
        entityId: before.id,
        before: {
          status: before.status,
          version: before.updatedAt.toISOString(),
        },
        after: { status: "canceled", version: now.toISOString() },
        metadata: {
          surface: "team.owner.payments",
          operation: input.operation,
          provider: "square",
          providerEffect: "none",
          reviewNoteProvided: true,
          confirmation: "no_square_charge",
        },
        committedAt: now,
      });
    }

    if (input.operation === "resolve_stripe_payment") {
      const [appointment] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .limit(1)
        .for("update");
      if (!appointment) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected appointment was not found.",
          { status: 404 },
        );
      }
      const [before] = await tx
        .select({
          id: payments.id,
          provider: payments.provider,
          appointmentId: payments.appointmentId,
          canonicalStatus: payments.canonicalStatus,
          updatedAt: payments.updatedAt,
        })
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .limit(1)
        .for("update");
      if (!before) {
        throw new TeamMutationFailure(
          "invalid",
          "The historical Stripe payment was not found.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, before.updatedAt);
      const now = nextPaymentReconciliationVersion(before.updatedAt);
      const resolution = await resolveLegacyStripePaymentInTransaction(tx, {
        paymentId: before.id,
        appointmentId: input.appointmentId,
        jobAmountCents: input.jobAmountCents,
        tipCents: input.tipCents,
        reviewNote: input.reviewNote,
        actorId: mutation.actor.id ?? null,
        actorLabel: mutation.actor.label ?? null,
        now,
      });
      if (!resolution.ok) throw legacyStripeFailure(resolution.code);

      const data: PaymentReconciliationMutationData = {
        operation: input.operation,
        outcome: "resolved",
        message:
          "The completed Stripe payment was attached with the confirmed job and tip allocation. The owner review is recorded.",
        providerEffect: "none",
        targetId: before.id,
        version: now.toISOString(),
        result: resolution,
      };
      return completeReconciliationMutation(tx, mutation, claim, data, {
        entityType: "payment",
        entityId: before.id,
        before: {
          provider: before.provider,
          appointmentId: before.appointmentId,
          canonicalStatus: before.canonicalStatus,
          version: before.updatedAt.toISOString(),
        },
        after: {
          appointmentId: resolution.appointmentId,
          canonicalStatus: "completed",
          jobAmountCents: resolution.jobAmountCents,
          tipCents: resolution.tipCents,
          version: now.toISOString(),
        },
        metadata: {
          surface: "team.owner.payments",
          operation: input.operation,
          provider: "stripe",
          providerEffect: "none",
          reviewNoteProvided: true,
          confirmation: "attach_stripe_payment",
        },
        committedAt: now,
      });
    }

    await acquireProviderReconciliationLock(tx);
    const [before] = await tx
      .select({
        id: paymentRefunds.id,
        paymentId: paymentRefunds.paymentId,
        provider: paymentRefunds.provider,
        canonicalStatus: paymentRefunds.canonicalStatus,
        metadata: paymentRefunds.metadata,
        updatedAt: paymentRefunds.updatedAt,
      })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.id, input.refundId))
      .limit(1)
      .for("update");
    if (!before || before.provider !== "square") {
      throw new TeamMutationFailure(
        "invalid",
        "The Square refund was not found.",
        { status: 404 },
      );
    }
    assertTeamMutationExpectedVersion(mutation, before.updatedAt);
    if (
      before.metadata?.["commissionReviewRequired"] !== true ||
      before.metadata?.["commissionReviewAcknowledgedAt"]
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "This refund no longer requires a commission-impact acknowledgement. Refresh the review list.",
      );
    }

    const now = nextPaymentReconciliationVersion(before.updatedAt);
    const [updated] = await tx
      .update(paymentRefunds)
      .set({
        metadata: {
          ...(before.metadata ?? {}),
          commissionReviewRequired: true,
          commissionReviewAcknowledgedAt: now.toISOString(),
          commissionReviewAcknowledgedBy:
            mutation.actor.id ?? mutation.actor.label ?? "unknown",
          commissionReviewNote: input.reviewNote,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentRefunds.id, before.id),
          eq(paymentRefunds.updatedAt, before.updatedAt),
        ),
      )
      .returning({ id: paymentRefunds.id });
    if (!updated) {
      throw new TeamMutationFailure(
        "conflict",
        "The refund changed while the acknowledgement was being saved. Refresh and try again.",
        { retryable: true },
      );
    }

    const data: PaymentReconciliationMutationData = {
      operation: input.operation,
      outcome: "resolved",
      message:
        "The refund's commission impact was acknowledged. No payment, refund, commission, or payout amount was changed.",
      providerEffect: "none",
      targetId: before.id,
      version: now.toISOString(),
      result: {
        refundId: before.id,
        paymentId: before.paymentId,
        status: "commission_impact_acknowledged",
      },
    };
    return completeReconciliationMutation(tx, mutation, claim, data, {
      entityType: "payment_refund",
      entityId: before.id,
      before: {
        canonicalStatus: before.canonicalStatus,
        commissionReviewAcknowledged: false,
        version: before.updatedAt.toISOString(),
      },
      after: {
        canonicalStatus: before.canonicalStatus,
        commissionReviewAcknowledged: true,
        version: now.toISOString(),
      },
      metadata: {
        surface: "team.owner.payments",
        operation: input.operation,
        provider: "square",
        providerEffect: "none",
        reviewNoteProvided: true,
        confirmation: "acknowledge_refund_impact",
      },
      committedAt: now,
    });
  });
}

export async function executePaymentReconciliationMutation(input: {
  db: DatabaseClient;
  mutation: TeamMutationContext;
  request: PaymentReconciliationRequest;
}): Promise<Response> {
  const { db, mutation, request } = input;
  try {
    requireExpectedVersion(mutation, request.operation);
  } catch (error) {
    return teamMutationExceptionResponse(error, mutation);
  }

  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const target = mutationTarget(request);
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/payments/reconciliation",
      entityType: target.entityType,
      entityId: target.entityId,
      payload: request,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = isProviderReadRequest(request)
      ? await executeProviderRead(db, mutation, claimed.claim, request)
      : await executeOwnerResolution(db, mutation, claimed.claim, request);
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[payments] reconciliation_idempotency_settlement_failed",
          {
            operationId: mutation.operationId,
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

export function invalidPaymentReconciliationRequest(
  mutation: TeamMutationContext,
): Response {
  return teamMutationErrorResponse(
    "invalid",
    "The payment reconciliation request is incomplete or does not match its confirmation.",
    {
      correlationId: mutation.correlationId,
      fieldErrors: {
        reconciliation:
          "Refresh the review list, confirm the exact action, and try again.",
      },
    },
  );
}
