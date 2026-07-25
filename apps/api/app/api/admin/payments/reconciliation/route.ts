import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  paymentAttempts,
  paymentProviderEvents,
  paymentRefunds,
  payments,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { canDismissSquareAttemptAfterReview } from "@/lib/payment-ledger";
import { resolveLegacyStripePayment } from "@/lib/payment-reconciliation";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import {
  canReclaimSquareProviderEvent,
  completeSquareProviderEvent,
  reconcileSquareAttempt,
  reconcilePendingSquareAttempts,
  reconcileSquarePaymentEvent,
  reconcileSquareRefundEvent,
  SQUARE_PROVIDER_EVENT_LEASE_MS,
} from "@/lib/square-payments";
import { isAdminRequest } from "../../../web/admin";

const ReconcileSchema = z
  .object({
    attemptId: z.string().uuid().optional(),
    dismissAttemptId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    providerPaymentId: z.string().trim().min(1).max(200).optional(),
    providerRefundId: z.string().trim().min(1).max(200).optional(),
    acknowledgeRefundId: z.string().uuid().optional(),
    stripePaymentId: z.string().uuid().optional(),
    appointmentId: z.string().uuid().optional(),
    jobAmountCents: z.number().int().nonnegative().max(100_000_000).optional(),
    tipCents: z.number().int().nonnegative().max(10_000_000).optional(),
    reviewNote: z.string().trim().min(1).max(500).optional(),
    sweep: z.literal(true).optional(),
  })
  .refine(
    (value) =>
      [
        value.attemptId,
        value.dismissAttemptId,
        value.eventId,
        value.providerPaymentId,
        value.providerRefundId,
        value.acknowledgeRefundId,
        value.stripePaymentId,
        value.sweep,
      ].filter(Boolean).length === 1,
    "Provide exactly one reconciliation target.",
  )
  .refine(
    (value) =>
      !value.reviewNote ||
      Boolean(
        value.acknowledgeRefundId ||
          value.dismissAttemptId ||
          value.stripePaymentId,
      ),
    "A review note is only valid for an owner resolution action.",
  )
  .refine(
    (value) =>
      !(
        value.dismissAttemptId ||
        value.acknowledgeRefundId ||
        value.stripePaymentId
      ) || Boolean(value.reviewNote),
    "A review note is required for dismiss, acknowledgement, and Stripe resolution actions.",
  )
  .refine(
    (value) =>
      !value.stripePaymentId ||
      (Boolean(value.appointmentId) &&
        value.jobAmountCents !== undefined &&
        value.tipCents !== undefined),
    "Stripe resolution requires appointmentId, jobAmountCents, and tipCents.",
  )
  .refine(
    (value) =>
      Boolean(value.stripePaymentId) ||
      (value.appointmentId === undefined &&
        value.jobAmountCents === undefined &&
        value.tipCents === undefined),
    "Stripe allocation fields are only valid for Stripe resolution.",
  );

async function authorize(request: NextRequest): Promise<Response | null> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;
  const role = getAuditActorFromRequest(request).role?.trim().toLowerCase();
  if (role !== "owner") {
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  }
  return null;
}

function providerObjectId(
  payload: Record<string, unknown> | null,
): string | null {
  const value = payload?.["objectId"];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function retrySquareProviderEvent(
  db: ReturnType<typeof getDb>,
  eventId: string,
): Promise<
  | {
      kind: "retried";
      eventId: string;
      providerEventId: string;
      providerObjectId: string;
      eventType: string;
      result: unknown;
    }
  | { kind: "not_found" }
  | { kind: "not_retryable"; status: string }
  | { kind: "unsupported"; eventType: string }
  | { kind: "object_id_missing"; eventType: string }
  | { kind: "lease_lost" }
  | { kind: "failed"; eventId: string; error: string }
> {
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
  if (!event || event.provider !== "square") {
    return { kind: "not_found" };
  }
  const retryable =
    event.processingStatus === "needs_review" ||
    canReclaimSquareProviderEvent({
      processingStatus: event.processingStatus,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
    });
  if (!retryable) {
    return {
      kind: "not_retryable",
      status: event.processingStatus,
    };
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
  const leaseId = crypto.randomUUID();
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

export async function GET(request: NextRequest): Promise<Response> {
  const authorizationError = await authorize(request);
  if (authorizationError) return authorizationError;

  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }
  const staleProviderEventLeaseCutoff = new Date(
    Date.now() - SQUARE_PROVIDER_EVENT_LEASE_MS,
  );
  const [attempts, unmatchedPayments, events, refunds] = await Promise.all([
    db
      .select({
        id: paymentAttempts.id,
        appointmentId: paymentAttempts.appointmentId,
        status: paymentAttempts.status,
        requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
        providerOrderId: paymentAttempts.providerOrderId,
        providerPaymentId: paymentAttempts.providerPaymentId,
        errorCode: paymentAttempts.errorCode,
        errorMessage: paymentAttempts.errorMessage,
        expiresAt: paymentAttempts.expiresAt,
        createdAt: paymentAttempts.createdAt,
        updatedAt: paymentAttempts.updatedAt,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            "created",
            "launched",
            "pending_verification",
            "needs_review",
            "failed",
            "expired",
          ]),
        ),
      )
      .orderBy(desc(paymentAttempts.updatedAt))
      .limit(200),
    db
      .select({
        id: payments.id,
        provider: payments.provider,
        appointmentId: payments.appointmentId,
        providerPaymentId: payments.providerPaymentId,
        providerOrderId: payments.providerOrderId,
        status: payments.status,
        amount: payments.amount,
        jobAmountCents: payments.jobAmountCents,
        tipCents: payments.tipCents,
        totalAmountCents: payments.totalAmountCents,
        refundedAmountCents: payments.refundedAmountCents,
        currency: payments.currency,
        canonicalStatus: payments.canonicalStatus,
        providerStatus: payments.providerStatus,
        receiptUrl: payments.receiptUrl,
        metadata: payments.metadata,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(
        and(
          inArray(payments.provider, ["square", "stripe"]),
          or(
            isNull(payments.appointmentId),
            eq(payments.canonicalStatus, "needs_review"),
          ),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(200),
    db
      .select({
        id: paymentProviderEvents.id,
        providerEventId: paymentProviderEvents.providerEventId,
        eventType: paymentProviderEvents.eventType,
        processingStatus: paymentProviderEvents.processingStatus,
        paymentId: paymentProviderEvents.paymentId,
        paymentAttemptId: paymentProviderEvents.paymentAttemptId,
        payload: paymentProviderEvents.payload,
        error: paymentProviderEvents.error,
        receivedAt: paymentProviderEvents.receivedAt,
        processedAt: paymentProviderEvents.processedAt,
      })
      .from(paymentProviderEvents)
      .where(
        and(
          eq(paymentProviderEvents.provider, "square"),
          or(
            inArray(paymentProviderEvents.processingStatus, [
              "failed",
              "needs_review",
            ]),
            and(
              inArray(paymentProviderEvents.processingStatus, [
                "processing",
                "received",
              ]),
              or(
                lte(
                  paymentProviderEvents.processedAt,
                  staleProviderEventLeaseCutoff,
                ),
                and(
                  isNull(paymentProviderEvents.processedAt),
                  lte(
                    paymentProviderEvents.receivedAt,
                    staleProviderEventLeaseCutoff,
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(paymentProviderEvents.receivedAt))
      .limit(200),
    db
      .select({
        id: paymentRefunds.id,
        paymentId: paymentRefunds.paymentId,
        providerRefundId: paymentRefunds.providerRefundId,
        amountCents: paymentRefunds.amountCents,
        jobAmountCents: paymentRefunds.jobAmountCents,
        tipCents: paymentRefunds.tipCents,
        canonicalStatus: paymentRefunds.canonicalStatus,
        providerStatus: paymentRefunds.providerStatus,
        reason: paymentRefunds.reason,
        metadata: paymentRefunds.metadata,
        createdAt: paymentRefunds.createdAt,
      })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.provider, "square"),
          or(
            eq(paymentRefunds.canonicalStatus, "needs_review"),
            and(
              sql`${paymentRefunds.metadata}->>'commissionReviewRequired' = 'true'`,
              sql`${paymentRefunds.metadata}->>'commissionReviewAcknowledgedAt' is null`,
            ),
          ),
        ),
      )
      .orderBy(desc(paymentRefunds.createdAt))
      .limit(200),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    attempts,
    unmatchedPayments,
    events: events.map(({ payload, ...event }) => ({
      ...event,
      providerObjectId: providerObjectId(payload),
    })),
    refunds,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const authorizationError = await authorize(request);
  if (authorizationError) return authorizationError;
  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }
  const parsed = ReconcileSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const actor = getAuditActorFromRequest(request);
  let result: unknown;
  let auditAction = "payment.square.reconciled";
  if (parsed.data.sweep) {
    result = await reconcilePendingSquareAttempts();
    auditAction = "payment.square.sweep_completed";
  } else if (parsed.data.attemptId) {
    result = await reconcileSquareAttempt({
      attemptId: parsed.data.attemptId,
    });
    auditAction = "payment.square.attempt_retried";
  } else if (parsed.data.dismissAttemptId) {
    const dismissedAt = new Date();
    const dismissal = await db.transaction(async (tx) => {
      const [attempt] = await tx
        .select({
          id: paymentAttempts.id,
          appointmentId: paymentAttempts.appointmentId,
          provider: paymentAttempts.provider,
          status: paymentAttempts.status,
          metadata: paymentAttempts.metadata,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, parsed.data.dismissAttemptId!))
        .limit(1)
        .for("update");
      if (!attempt || attempt.provider !== "square") {
        return { kind: "not_found" as const };
      }
      if (!canDismissSquareAttemptAfterReview(attempt.status)) {
        return {
          kind: "not_dismissible" as const,
          status: attempt.status,
        };
      }
      const reviewNote = parsed.data.reviewNote!;
      await tx
        .update(paymentAttempts)
        .set({
          status: "canceled",
          resolvedAt: dismissedAt,
          errorCode: "owner_dismissed_after_provider_review",
          errorMessage: reviewNote,
          metadata: {
            ...(attempt.metadata ?? {}),
            ownerDismissedAt: dismissedAt.toISOString(),
            ownerDismissedBy: actor.id ?? actor.label ?? "owner",
            ownerDismissalReviewNote: reviewNote,
          },
          updatedAt: dismissedAt,
        })
        .where(eq(paymentAttempts.id, attempt.id));
      return {
        kind: "dismissed" as const,
        attemptId: attempt.id,
        appointmentId: attempt.appointmentId,
        previousStatus: attempt.status,
        dismissedAt: dismissedAt.toISOString(),
      };
    });
    if (dismissal.kind === "not_found") {
      return NextResponse.json(
        { error: "payment_attempt_not_found" },
        { status: 404 },
      );
    }
    if (dismissal.kind === "not_dismissible") {
      return NextResponse.json(
        {
          error: "square_attempt_not_dismissible",
          status: dismissal.status,
        },
        { status: 409 },
      );
    }
    result = dismissal;
    auditAction = "payment.square.attempt_dismissed";
  } else if (parsed.data.eventId) {
    const eventResult = await retrySquareProviderEvent(db, parsed.data.eventId);
    if (eventResult.kind === "not_found") {
      return NextResponse.json(
        { error: "payment_provider_event_not_found" },
        { status: 404 },
      );
    }
    if (eventResult.kind === "not_retryable") {
      return NextResponse.json(
        {
          error: "payment_provider_event_not_retryable",
          status: eventResult.status,
        },
        { status: 409 },
      );
    }
    if (eventResult.kind === "unsupported") {
      return NextResponse.json(
        {
          error: "payment_provider_event_unsupported",
          eventType: eventResult.eventType,
        },
        { status: 409 },
      );
    }
    if (eventResult.kind === "object_id_missing") {
      return NextResponse.json(
        {
          error: "payment_provider_event_object_id_missing",
          eventType: eventResult.eventType,
        },
        { status: 409 },
      );
    }
    if (eventResult.kind === "lease_lost") {
      return NextResponse.json(
        { error: "payment_provider_event_retry_conflict" },
        { status: 409 },
      );
    }
    result = eventResult;
    auditAction = "payment.square.event_retried";
    if (eventResult.kind === "failed") {
      await recordAuditEvent({
        actor,
        action: auditAction,
        entityType: "payment_reconciliation",
        entityId: parsed.data.eventId,
        meta: {
          target: { eventId: parsed.data.eventId },
          result: eventResult,
        },
      });
      return NextResponse.json(
        {
          error: "payment_provider_event_retry_failed",
          result: eventResult,
        },
        { status: 502 },
      );
    }
  } else if (parsed.data.providerPaymentId) {
    result = await reconcileSquarePaymentEvent(parsed.data.providerPaymentId);
    auditAction = "payment.square.payment_retried";
  } else if (parsed.data.providerRefundId) {
    result = await reconcileSquareRefundEvent(parsed.data.providerRefundId);
    auditAction = "payment.square.refund_retried";
  } else if (parsed.data.stripePaymentId) {
    const resolution = await resolveLegacyStripePayment({
      db,
      paymentId: parsed.data.stripePaymentId,
      appointmentId: parsed.data.appointmentId!,
      jobAmountCents: parsed.data.jobAmountCents!,
      tipCents: parsed.data.tipCents!,
      reviewNote: parsed.data.reviewNote!,
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
    });
    if (!resolution.ok) {
      const notFound =
        resolution.code === "payment_not_found" ||
        resolution.code === "appointment_not_found";
      return NextResponse.json(
        { error: resolution.code },
        { status: notFound ? 404 : 409 },
      );
    }
    result = resolution;
    auditAction = "payment.stripe.owner_resolved";
  } else {
    const refundId = parsed.data.acknowledgeRefundId!;
    const acknowledgement = await db.transaction(async (tx) => {
      const [refund] = await tx
        .select({
          id: paymentRefunds.id,
          paymentId: paymentRefunds.paymentId,
          metadata: paymentRefunds.metadata,
        })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, refundId))
        .limit(1)
        .for("update");
      if (!refund) return { kind: "not_found" as const };
      if (
        refund.metadata?.["commissionReviewRequired"] !== true ||
        refund.metadata?.["commissionReviewAcknowledgedAt"]
      ) {
        return { kind: "not_acknowledgeable" as const };
      }
      const acknowledgedAt = new Date();
      await tx
        .update(paymentRefunds)
        .set({
          metadata: {
            ...(refund.metadata ?? {}),
            commissionReviewRequired: true,
            commissionReviewAcknowledgedAt: acknowledgedAt.toISOString(),
            commissionReviewAcknowledgedBy: actor.id ?? actor.label ?? "owner",
            commissionReviewNote: parsed.data.reviewNote!,
          },
          updatedAt: acknowledgedAt,
        })
        .where(eq(paymentRefunds.id, refund.id));
      return {
        kind: "acknowledged" as const,
        status: "commission_impact_acknowledged",
        refundId: refund.id,
        paymentId: refund.paymentId,
        acknowledgedAt: acknowledgedAt.toISOString(),
      };
    });
    if (acknowledgement.kind === "not_found") {
      return NextResponse.json(
        { error: "payment_refund_not_found" },
        { status: 404 },
      );
    }
    if (acknowledgement.kind === "not_acknowledgeable") {
      return NextResponse.json(
        { error: "payment_refund_not_acknowledgeable" },
        { status: 409 },
      );
    }
    result = acknowledgement;
    auditAction = "payment.square.refund_impact_acknowledged";
  }

  await recordAuditEvent({
    actor,
    action: auditAction,
    entityType: "payment_reconciliation",
    entityId:
      parsed.data.attemptId ??
      parsed.data.dismissAttemptId ??
      parsed.data.eventId ??
      parsed.data.stripePaymentId ??
      parsed.data.acknowledgeRefundId ??
      parsed.data.providerPaymentId ??
      parsed.data.providerRefundId ??
      null,
    meta: {
      target: parsed.data,
      result,
    },
  });
  return NextResponse.json({ ok: true, result });
}
