import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  getDb,
  paymentAttempts,
  paymentProviderEvents,
  paymentRefunds,
  payments,
} from "@/db";
import {
  executePaymentReconciliationMutation,
  invalidPaymentReconciliationRequest,
  PaymentReconciliationRequestSchema,
} from "@/lib/payment-reconciliation-admin";
import { squareProviderEventVersion } from "@/lib/payment-reconciliation-safety";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { SQUARE_PROVIDER_EVENT_LEASE_MS } from "@/lib/square-payments";
import {
  beginTeamMutation,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
} from "@/lib/team-mutation";
import { isAdminRequest } from "../../../web/admin";

async function authorizeReconciliationRead(
  request: NextRequest,
): Promise<Response | null> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return requirePermission(request, "payments.reconcile");
}

function providerObjectId(
  payload: Record<string, unknown> | null,
): string | null {
  const value = payload?.["objectId"];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authorizationError = await authorizeReconciliationRead(request);
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
        updatedAt: payments.updatedAt,
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
        updatedAt: paymentRefunds.updatedAt,
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
    attempts: attempts.map((attempt) => ({
      ...attempt,
      version: attempt.updatedAt.toISOString(),
    })),
    unmatchedPayments: unmatchedPayments.map((payment) => ({
      ...payment,
      version: payment.updatedAt.toISOString(),
    })),
    events: events.map(({ payload, ...event }) => ({
      ...event,
      providerObjectId: providerObjectId(payload),
      version: squareProviderEventVersion(event),
    })),
    refunds: refunds.map((refund) => ({
      ...refund,
      version: refund.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.reconcile", "payments.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "payment.reconciliation.executed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsed = PaymentReconciliationRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return invalidPaymentReconciliationRequest(mutation);

  try {
    const db = getDb();
    if (!(await isPaymentLedgerSchemaAvailable(db))) {
      return teamMutationErrorResponse(
        "internal",
        "Payment reconciliation is temporarily unavailable. No provider change was requested.",
        {
          status: 503,
          retryable: true,
          correlationId: mutation.correlationId,
        },
      );
    }
    return executePaymentReconciliationMutation({
      db,
      mutation,
      request: parsed.data,
    });
  } catch (error) {
    return teamMutationExceptionResponse(error, mutation);
  }
}
