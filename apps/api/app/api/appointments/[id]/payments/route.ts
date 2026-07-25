import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import {
  appointments,
  getDb,
  paymentAttempts,
  paymentRefunds,
} from "@/db";
import {
  getAppointmentPaymentSummary,
  listAppointmentPaymentRows,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.read");
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }
  const [appointment] = await db
    .select({
      id: appointments.id,
      finalTotalCents: appointments.finalTotalCents,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!appointment) {
    return NextResponse.json(
      { error: "appointment_not_found" },
      { status: 404 },
    );
  }

  const [ledgerRows, attempts, summary] = await Promise.all([
    listAppointmentPaymentRows(db, appointmentId),
    db
      .select({
        id: paymentAttempts.id,
        provider: paymentAttempts.provider,
        status: paymentAttempts.status,
        requestedJobAmountCents:
          paymentAttempts.requestedJobAmountCents,
        currency: paymentAttempts.currency,
        providerOrderId: paymentAttempts.providerOrderId,
        providerPaymentId: paymentAttempts.providerPaymentId,
        initiatedByMemberId: paymentAttempts.initiatedByMemberId,
        expiresAt: paymentAttempts.expiresAt,
        resolvedAt: paymentAttempts.resolvedAt,
        errorCode: paymentAttempts.errorCode,
        errorMessage: paymentAttempts.errorMessage,
        createdAt: paymentAttempts.createdAt,
        updatedAt: paymentAttempts.updatedAt,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.appointmentId, appointmentId))
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(20),
    getAppointmentPaymentSummary(db, appointmentId, {
      jobTotalCents: appointment.finalTotalCents,
    }),
  ]);
  const paymentIds = ledgerRows.map((row) => row.id);
  const refunds =
    paymentIds.length === 0
      ? []
      : await db
          .select({
            id: paymentRefunds.id,
            paymentId: paymentRefunds.paymentId,
            provider: paymentRefunds.provider,
            providerRefundId: paymentRefunds.providerRefundId,
            amountCents: paymentRefunds.amountCents,
            jobAmountCents: paymentRefunds.jobAmountCents,
            tipCents: paymentRefunds.tipCents,
            currency: paymentRefunds.currency,
            canonicalStatus: paymentRefunds.canonicalStatus,
            providerStatus: paymentRefunds.providerStatus,
            reason: paymentRefunds.reason,
            refundedAt: paymentRefunds.refundedAt,
            createdAt: paymentRefunds.createdAt,
          })
          .from(paymentRefunds)
          .where(inArray(paymentRefunds.paymentId, paymentIds))
          .orderBy(desc(paymentRefunds.createdAt));

  return NextResponse.json({
    appointmentId,
    paymentSummary: summary,
    payments: ledgerRows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
    })),
    refunds: refunds.map((row) => ({
      ...row,
      refundedAt: row.refundedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    attempts: attempts.map((row) => ({
      ...row,
      expiresAt: row.expiresAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}
