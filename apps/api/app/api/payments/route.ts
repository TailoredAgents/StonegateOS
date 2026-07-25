import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  isNull,
  isNotNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, payments, appointments, contacts } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { mapProviderPaymentStatus } from "@/lib/payment-summary";
import { isAdminRequest } from "../web/admin";

async function getLegacyPaymentsResponse(
  request: NextRequest,
  db: ReturnType<typeof getDb>,
): Promise<Response> {
  const statusFilter = request.nextUrl.searchParams.get("status");
  const providerFilter = request.nextUrl.searchParams
    .get("provider")
    ?.trim()
    .toLowerCase();
  const conditions: SQL[] = [];
  if (statusFilter === "unmatched") {
    conditions.push(isNull(payments.appointmentId));
  } else if (statusFilter === "matched") {
    conditions.push(isNotNull(payments.appointmentId));
  }

  const baseQuery = db
    .select({
      id: payments.id,
      stripeChargeId: payments.stripeChargeId,
      amount: payments.amount,
      currency: payments.currency,
      status: payments.status,
      method: payments.method,
      cardBrand: payments.cardBrand,
      last4: payments.last4,
      receiptUrl: payments.receiptUrl,
      metadata: payments.metadata,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
      capturedAt: payments.capturedAt,
      appointmentId: payments.appointmentId,
      appointmentStatus: appointments.status,
      appointmentStartAt: appointments.startAt,
      appointmentUpdatedAt: appointments.updatedAt,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
    })
    .from(payments)
    .leftJoin(appointments, eq(payments.appointmentId, appointments.id))
    .leftJoin(contacts, eq(appointments.contactId, contacts.id));
  const filteredQuery =
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

  const [queriedRows, summaryRow] = await Promise.all([
    filteredQuery.orderBy(desc(payments.createdAt)),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${payments.appointmentId} is not null)`,
      })
      .from(payments)
      .then((result) => result[0] ?? { total: 0, matched: 0 }),
  ]);
  const rows =
    statusFilter === "needs_review" ||
    (providerFilter && providerFilter !== "stripe")
      ? []
      : queriedRows;
  const paymentsDto = rows.map((row) => {
    const contactName =
      row.contactFirstName && row.contactLastName
        ? `${row.contactFirstName} ${row.contactLastName}`
        : row.contactFirstName ?? row.contactLastName ?? null;
    const canonicalStatus = mapProviderPaymentStatus("stripe", row.status);
    const paidAt = row.capturedAt ?? row.createdAt;

    return {
      id: row.id,
      stripeChargeId: row.stripeChargeId,
      provider: "stripe",
      providerPaymentId: row.stripeChargeId,
      providerOrderId: null,
      paymentAttemptId: null,
      amount: row.amount,
      jobAmountCents: row.amount,
      tipCents: 0,
      totalAmountCents: row.amount,
      refundedAmountCents: 0,
      currency: row.currency,
      status: row.status,
      canonicalStatus,
      providerStatus: row.status,
      method: row.method,
      tenderType: row.method,
      entryMethod: null,
      cardBrand: row.cardBrand,
      last4: row.last4,
      receiptUrl: row.receiptUrl,
      squareLocationId: null,
      initiatedByMemberId: null,
      legacySource: "stripe_import",
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      providerCreatedAt: row.createdAt.toISOString(),
      paidAt: paidAt.toISOString(),
      capturedAt: row.capturedAt?.toISOString() ?? null,
      appointment: row.appointmentId
        ? {
            id: row.appointmentId,
            status: row.appointmentStatus,
            startAt: row.appointmentStartAt?.toISOString() ?? null,
            updatedAt: row.appointmentUpdatedAt?.toISOString() ?? null,
            contactId: row.contactId,
            contactName,
            contactEmail: row.contactEmail,
            contactPhone: row.contactPhone,
            contactPhoneE164: row.contactPhoneE164,
          }
        : null,
    };
  });
  const total = Number(summaryRow.total ?? 0);
  const matched = Number(summaryRow.matched ?? 0);

  return NextResponse.json({
    payments: paymentsDto,
    summary: {
      total,
      matched,
      unmatched: Math.max(total - matched, 0),
      needsReview: 0,
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // This endpoint is the cross-customer reconciliation list. Appointment-
  // scoped reads use /api/appointments/:id/payments.
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return getLegacyPaymentsResponse(request, db);
  }
  const statusFilter = request.nextUrl.searchParams.get("status");
  const providerFilter = request.nextUrl.searchParams.get("provider")?.trim();

  const baseQuery = db
    .select({
      id: payments.id,
      stripeChargeId: payments.stripeChargeId,
      provider: payments.provider,
      providerPaymentId: payments.providerPaymentId,
      providerOrderId: payments.providerOrderId,
      paymentAttemptId: payments.paymentAttemptId,
      amount: payments.amount,
      jobAmountCents: payments.jobAmountCents,
      tipCents: payments.tipCents,
      totalAmountCents: payments.totalAmountCents,
      refundedAmountCents: payments.refundedAmountCents,
      currency: payments.currency,
      status: payments.status,
      canonicalStatus: payments.canonicalStatus,
      providerStatus: payments.providerStatus,
      method: payments.method,
      tenderType: payments.tenderType,
      entryMethod: payments.entryMethod,
      cardBrand: payments.cardBrand,
      last4: payments.last4,
      receiptUrl: payments.receiptUrl,
      squareLocationId: payments.squareLocationId,
      initiatedByMemberId: payments.initiatedByMemberId,
      legacySource: payments.legacySource,
      metadata: payments.metadata,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
      providerCreatedAt: payments.providerCreatedAt,
      paidAt: payments.paidAt,
      capturedAt: payments.capturedAt,
      appointmentId: payments.appointmentId,
      appointmentStatus: appointments.status,
      appointmentStartAt: appointments.startAt,
      appointmentUpdatedAt: appointments.updatedAt,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164
    })
    .from(payments)
    .leftJoin(appointments, eq(payments.appointmentId, appointments.id))
    .leftJoin(contacts, eq(appointments.contactId, contacts.id));

  const conditions: SQL[] = [];
  if (statusFilter === "unmatched") {
    conditions.push(isNull(payments.appointmentId));
  } else if (statusFilter === "matched") {
    conditions.push(isNotNull(payments.appointmentId));
  } else if (statusFilter === "needs_review") {
    conditions.push(eq(payments.canonicalStatus, "needs_review"));
  }
  if (providerFilter) {
    conditions.push(eq(payments.provider, providerFilter));
  }
  const filteredQuery =
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

  const [rows, summaryRow] = await Promise.all([
    filteredQuery.orderBy(desc(payments.createdAt)),
    db
      .select({
        total: sql<number>`count(*)`,
        matched: sql<number>`count(*) filter (where ${payments.appointmentId} is not null)`,
        needsReview: sql<number>`count(*) filter (where ${payments.canonicalStatus} = 'needs_review')`
      })
      .from(payments)
      .then((result) => result[0] ?? { total: 0, matched: 0, needsReview: 0 })
  ]);

  const total = Number(summaryRow.total ?? 0);
  const matched = Number(summaryRow.matched ?? 0);
  const summary = {
    total,
    matched,
    unmatched: Math.max(total - matched, 0),
    needsReview: Number(summaryRow.needsReview ?? 0)
  };

  const paymentsDto = rows.map((row) => {
    const contactName = row.contactFirstName && row.contactLastName
      ? `${row.contactFirstName} ${row.contactLastName}`
      : row.contactFirstName ?? row.contactLastName ?? null;

    return {
      id: row.id,
      stripeChargeId: row.stripeChargeId,
      provider: row.provider,
      providerPaymentId: row.providerPaymentId,
      providerOrderId: row.providerOrderId,
      paymentAttemptId: row.paymentAttemptId,
      amount: row.amount,
      jobAmountCents: row.jobAmountCents ?? row.amount,
      tipCents: row.tipCents,
      totalAmountCents: row.totalAmountCents ?? row.amount,
      refundedAmountCents: row.refundedAmountCents,
      currency: row.currency,
      status: row.status,
      canonicalStatus: row.canonicalStatus ?? row.status,
      providerStatus: row.providerStatus ?? row.status,
      method: row.method,
      tenderType: row.tenderType ?? row.method,
      entryMethod: row.entryMethod,
      cardBrand: row.cardBrand,
      last4: row.last4,
      receiptUrl: row.receiptUrl,
      squareLocationId: row.squareLocationId,
      initiatedByMemberId: row.initiatedByMemberId,
      legacySource: row.legacySource,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      providerCreatedAt: row.providerCreatedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
      appointment: row.appointmentId
        ? {
            id: row.appointmentId,
            status: row.appointmentStatus,
            startAt: row.appointmentStartAt ? row.appointmentStartAt.toISOString() : null,
            updatedAt: row.appointmentUpdatedAt ? row.appointmentUpdatedAt.toISOString() : null,
            contactId: row.contactId,
            contactName,
            contactEmail: row.contactEmail,
            contactPhone: row.contactPhone,
            contactPhoneE164: row.contactPhoneE164
          }
        : null
    };
  });

  return NextResponse.json({ payments: paymentsDto, summary });
}
