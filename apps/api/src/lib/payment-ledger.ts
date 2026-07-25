import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  appointments,
  getDb,
  paymentAttempts,
  paymentRefunds,
  payments,
} from "@/db";
import {
  buildAppointmentPaymentSummary,
  type AppointmentPaymentSummary,
  type PaymentSummaryEntry,
} from "@/lib/payment-summary";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";

export const ACTIVE_PAYMENT_ATTEMPT_STATUSES = [
  "created",
  "launched",
  "pending_verification",
] as const;

export const UNRESOLVED_SQUARE_ATTEMPT_STATUSES = [
  "expired",
  "needs_review",
] as const;

export const PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES = [
  ...ACTIVE_PAYMENT_ATTEMPT_STATUSES,
  ...UNRESOLVED_SQUARE_ATTEMPT_STATUSES,
] as const;

export function requiresSquareAttemptReconciliation(
  status: string | null | undefined,
): boolean {
  return UNRESOLVED_SQUARE_ATTEMPT_STATUSES.includes(
    status as (typeof UNRESOLVED_SQUARE_ATTEMPT_STATUSES)[number],
  );
}

export function blocksPaymentMutationForAttempt(
  status: string | null | undefined,
): boolean {
  return PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES.includes(
    status as (typeof PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES)[number],
  );
}

export function canDismissSquareAttemptAfterReview(
  status: string | null | undefined,
): boolean {
  return status === "failed" || requiresSquareAttemptReconciliation(status);
}

export type PaymentAttemptStatus =
  | (typeof ACTIVE_PAYMENT_ATTEMPT_STATUSES)[number]
  | "completed"
  | "canceled"
  | "failed"
  | "needs_review"
  | "expired";

export type SquareAttemptSummaryState = {
  activeAttemptId: string | null;
  needsReview: boolean;
};

export function summarizeSquareAttempts(
  attempts: ReadonlyArray<{
    id: string;
    status: string;
    expiresAt: Date;
  }>,
  now = new Date(),
): SquareAttemptSummaryState {
  let activeAttemptId: string | null = null;
  let needsReview = false;

  for (const attempt of attempts) {
    if (requiresSquareAttemptReconciliation(attempt.status)) {
      needsReview = true;
      continue;
    }
    if (
      ACTIVE_PAYMENT_ATTEMPT_STATUSES.includes(
        attempt.status as (typeof ACTIVE_PAYMENT_ATTEMPT_STATUSES)[number],
      )
    ) {
      if (attempt.expiresAt.getTime() <= now.getTime()) {
        needsReview = true;
      } else if (!activeAttemptId) {
        activeAttemptId = attempt.id;
      }
    }
  }

  return { activeAttemptId, needsReview };
}

type TransactionClient = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];

export type PaymentDatabase = DatabaseClient | TransactionClient;

type PaymentLedgerSchemaOptions = {
  schemaAvailable?: boolean;
};

async function resolvePaymentLedgerSchemaAvailability(
  db: PaymentDatabase,
  options?: PaymentLedgerSchemaOptions,
): Promise<boolean> {
  return options?.schemaAvailable ?? (await isPaymentLedgerSchemaAvailable(db));
}

export type PaymentLedgerRow = {
  id: string;
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  paymentAttemptId: string | null;
  appointmentId: string | null;
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  refundedAmountCents: number;
  currency: string;
  canonicalStatus: string;
  providerStatus: string;
  tenderType: string | null;
  entryMethod: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  initiatedByMemberId: string | null;
  legacySource: string | null;
  createdAt: Date;
  paidAt: Date | null;
};

function resolvedJobAmount(row: {
  jobAmountCents: number | null;
  amount: number;
  tipCents: number;
}): number {
  if (row.jobAmountCents != null) return Math.max(row.jobAmountCents, 0);
  return Math.max(row.amount - Math.max(row.tipCents, 0), 0);
}

function resolvedTotalAmount(row: {
  totalAmountCents: number | null;
  amount: number;
}): number {
  return Math.max(row.totalAmountCents ?? row.amount, 0);
}

function resolvedCanonicalStatus(row: {
  canonicalStatus: string | null;
  status: string;
}): string {
  if (row.canonicalStatus) return row.canonicalStatus;
  return row.status === "succeeded" ? "completed" : row.status;
}

function isProviderFinanciallyCompleted(row: {
  canonicalStatus: string;
  providerStatus: string;
}): boolean {
  const providerStatus = row.providerStatus.trim().toLowerCase();
  return (
    row.canonicalStatus === "completed" ||
    providerStatus === "completed" ||
    providerStatus === "succeeded"
  );
}

export async function listAppointmentPaymentRows(
  db: PaymentDatabase,
  appointmentId: string,
  options?: PaymentLedgerSchemaOptions,
): Promise<PaymentLedgerRow[]> {
  if (!(await resolvePaymentLedgerSchemaAvailability(db, options))) {
    return [];
  }

  const rows = await db
    .select({
      id: payments.id,
      provider: payments.provider,
      providerPaymentId: payments.providerPaymentId,
      providerOrderId: payments.providerOrderId,
      paymentAttemptId: payments.paymentAttemptId,
      appointmentId: payments.appointmentId,
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
      initiatedByMemberId: payments.initiatedByMemberId,
      legacySource: payments.legacySource,
      createdAt: payments.createdAt,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.appointmentId, appointmentId))
    .orderBy(desc(payments.createdAt));

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    providerOrderId: row.providerOrderId,
    paymentAttemptId: row.paymentAttemptId,
    appointmentId: row.appointmentId,
    jobAmountCents: resolvedJobAmount(row),
    tipCents: Math.max(row.tipCents, 0),
    totalAmountCents: resolvedTotalAmount(row),
    refundedAmountCents: Math.max(row.refundedAmountCents, 0),
    currency: row.currency,
    canonicalStatus: resolvedCanonicalStatus(row),
    providerStatus: row.providerStatus ?? row.status,
    tenderType: row.tenderType ?? row.method,
    entryMethod: row.entryMethod,
    cardBrand: row.cardBrand,
    last4: row.last4,
    receiptUrl: row.receiptUrl,
    initiatedByMemberId: row.initiatedByMemberId,
    legacySource: row.legacySource,
    createdAt: row.createdAt,
    paidAt: row.paidAt ?? null,
  }));
}

export async function getActivePaymentAttempt(
  db: PaymentDatabase,
  appointmentId: string,
  now = new Date(),
  options?: PaymentLedgerSchemaOptions,
) {
  if (!(await resolvePaymentLedgerSchemaAvailability(db, options))) {
    return null;
  }

  const [row] = await db
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      provider: paymentAttempts.provider,
      clientRequestId: paymentAttempts.clientRequestId,
      status: paymentAttempts.status,
      requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
      currency: paymentAttempts.currency,
      providerOrderId: paymentAttempts.providerOrderId,
      providerPaymentId: paymentAttempts.providerPaymentId,
      squareLocationId: paymentAttempts.squareLocationId,
      initiatedByMemberId: paymentAttempts.initiatedByMemberId,
      returnNonceHash: paymentAttempts.returnNonceHash,
      returnStateExpiresAt: paymentAttempts.returnStateExpiresAt,
      expiresAt: paymentAttempts.expiresAt,
      metadata: paymentAttempts.metadata,
      createdAt: paymentAttempts.createdAt,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, appointmentId),
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [...ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
        gt(paymentAttempts.expiresAt, now),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getBlockingSquareAttempt(
  db: PaymentDatabase,
  appointmentId: string,
): Promise<{ id: string; status: string } | null> {
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return null;
  }
  const [row] = await db
    .select({
      id: paymentAttempts.id,
      status: paymentAttempts.status,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, appointmentId),
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(paymentAttempts.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function expireStalePaymentAttemptsForAppointment(
  db: PaymentDatabase,
  appointmentId: string,
  now = new Date(),
): Promise<void> {
  if (!(await isPaymentLedgerSchemaAvailable(db))) return;
  await db
    .update(paymentAttempts)
    .set({ status: "expired", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentAttempts.appointmentId, appointmentId),
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [...ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
        lte(paymentAttempts.expiresAt, now),
      ),
    );
}

export async function getAppointmentPaymentSummary(
  db: PaymentDatabase,
  appointmentId: string,
  options?: {
    jobTotalCents?: number | null;
    now?: Date;
    schemaAvailable?: boolean;
  },
): Promise<AppointmentPaymentSummary> {
  let jobTotalCents = options?.jobTotalCents;
  if (jobTotalCents === undefined) {
    const [appointment] = await db
      .select({ finalTotalCents: appointments.finalTotalCents })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    jobTotalCents = appointment?.finalTotalCents ?? null;
  }
  const schemaAvailable = await resolvePaymentLedgerSchemaAvailability(
    db,
    options,
  );
  if (!schemaAvailable) {
    return buildAppointmentPaymentSummary({
      jobTotalCents: jobTotalCents ?? null,
      entries: [],
    });
  }

  const [rows, attempts] = await Promise.all([
    listAppointmentPaymentRows(db, appointmentId, {
      schemaAvailable: true,
    }),
    listSquareAttemptsForAppointmentSummary(db, appointmentId),
  ]);
  const attemptSummary = summarizeSquareAttempts(attempts, options?.now);
  const rowIds = rows.map((row) => row.id);
  const reviewRefundPaymentIds = new Set<string>();
  if (rowIds.length > 0) {
    const reviewRefunds = await db
      .select({ paymentId: paymentRefunds.paymentId })
      .from(paymentRefunds)
      .where(
        and(
          inArray(paymentRefunds.paymentId, rowIds),
          eq(paymentRefunds.canonicalStatus, "needs_review"),
        ),
      );
    for (const refund of reviewRefunds) {
      reviewRefundPaymentIds.add(refund.paymentId);
    }
  }

  const entries: PaymentSummaryEntry[] = rows.map((row) => ({
    canonicalStatus: row.canonicalStatus,
    jobAmountCents: row.jobAmountCents,
    tipCents: row.tipCents,
    refundedAmountCents: row.refundedAmountCents,
    needsReview: reviewRefundPaymentIds.has(row.id),
    countTowardBalance: isProviderFinanciallyCompleted(row),
    receiptUrl: row.receiptUrl,
    capturedAt: row.paidAt,
    createdAt: row.createdAt,
  }));

  return buildAppointmentPaymentSummary({
    jobTotalCents: jobTotalCents ?? null,
    entries,
    activeAttemptId: attemptSummary.activeAttemptId,
    needsReview: attemptSummary.needsReview,
  });
}

export async function getAppointmentPaymentSummaryMap(
  appointmentIds: string[],
  jobTotalByAppointmentId?: ReadonlyMap<string, number | null>,
  now = new Date(),
): Promise<Map<string, AppointmentPaymentSummary>> {
  const uniqueIds = [...new Set(appointmentIds)];
  const summaries = new Map<string, AppointmentPaymentSummary>();
  for (const appointmentId of uniqueIds) {
    summaries.set(
      appointmentId,
      buildAppointmentPaymentSummary({
        jobTotalCents: jobTotalByAppointmentId?.get(appointmentId) ?? null,
        entries: [],
      }),
    );
  }
  if (uniqueIds.length === 0) return summaries;
  if (!(await isPaymentLedgerSchemaAvailable())) return summaries;

  let totals = jobTotalByAppointmentId;
  if (!totals) {
    const appointmentRows = await getDbAppointments(uniqueIds);
    totals = new Map(
      appointmentRows.map((row) => [row.id, row.finalTotalCents]),
    );
  }
  const [rows, attempts] = await Promise.all([
    listPaymentRowsForAppointments(uniqueIds),
    listSquareAttemptsForAppointments(uniqueIds),
  ]);
  const paymentIds = rows.map((row) => row.id);
  const reviewRefundPaymentIds = new Set<string>();
  if (paymentIds.length > 0) {
    const db = getDb();
    const reviewRefunds = await db
      .select({ paymentId: paymentRefunds.paymentId })
      .from(paymentRefunds)
      .where(
        and(
          inArray(paymentRefunds.paymentId, paymentIds),
          eq(paymentRefunds.canonicalStatus, "needs_review"),
        ),
      );
    for (const refund of reviewRefunds) {
      reviewRefundPaymentIds.add(refund.paymentId);
    }
  }

  const rowsByAppointment = new Map<string, PaymentLedgerRow[]>();
  for (const row of rows) {
    if (!row.appointmentId) continue;
    const list = rowsByAppointment.get(row.appointmentId) ?? [];
    list.push(row);
    rowsByAppointment.set(row.appointmentId, list);
  }
  const activeByAppointment = new Map<string, string>();
  const attemptReviewByAppointment = new Set<string>();
  const attemptsByAppointment = new Map<
    string,
    Array<{ id: string; status: string; expiresAt: Date }>
  >();
  for (const attempt of attempts) {
    const appointmentAttempts =
      attemptsByAppointment.get(attempt.appointmentId) ?? [];
    appointmentAttempts.push(attempt);
    attemptsByAppointment.set(attempt.appointmentId, appointmentAttempts);
  }
  for (const [appointmentId, appointmentAttempts] of attemptsByAppointment) {
    const attemptSummary = summarizeSquareAttempts(appointmentAttempts, now);
    if (attemptSummary.activeAttemptId) {
      activeByAppointment.set(appointmentId, attemptSummary.activeAttemptId);
    }
    if (attemptSummary.needsReview) {
      attemptReviewByAppointment.add(appointmentId);
    }
  }
  for (const appointmentId of uniqueIds) {
    const appointmentRows = rowsByAppointment.get(appointmentId) ?? [];
    summaries.set(
      appointmentId,
      buildAppointmentPaymentSummary({
        jobTotalCents: totals.get(appointmentId) ?? null,
        activeAttemptId: activeByAppointment.get(appointmentId) ?? null,
        needsReview: attemptReviewByAppointment.has(appointmentId),
        entries: appointmentRows.map((row) => ({
          canonicalStatus: row.canonicalStatus,
          jobAmountCents: row.jobAmountCents,
          tipCents: row.tipCents,
          refundedAmountCents: row.refundedAmountCents,
          needsReview: reviewRefundPaymentIds.has(row.id),
          countTowardBalance: isProviderFinanciallyCompleted(row),
          receiptUrl: row.receiptUrl,
          capturedAt: row.paidAt,
          createdAt: row.createdAt,
        })),
      }),
    );
  }
  return summaries;
}

async function getDbAppointments(appointmentIds: string[]) {
  const db = getDb();
  return db
    .select({
      id: appointments.id,
      finalTotalCents: appointments.finalTotalCents,
    })
    .from(appointments)
    .where(inArray(appointments.id, appointmentIds));
}

async function listPaymentRowsForAppointments(
  appointmentIds: string[],
): Promise<PaymentLedgerRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: payments.id,
      provider: payments.provider,
      providerPaymentId: payments.providerPaymentId,
      providerOrderId: payments.providerOrderId,
      paymentAttemptId: payments.paymentAttemptId,
      appointmentId: payments.appointmentId,
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
      initiatedByMemberId: payments.initiatedByMemberId,
      legacySource: payments.legacySource,
      createdAt: payments.createdAt,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(inArray(payments.appointmentId, appointmentIds))
    .orderBy(desc(payments.createdAt));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    providerOrderId: row.providerOrderId,
    paymentAttemptId: row.paymentAttemptId,
    appointmentId: row.appointmentId,
    jobAmountCents: resolvedJobAmount(row),
    tipCents: Math.max(row.tipCents, 0),
    totalAmountCents: resolvedTotalAmount(row),
    refundedAmountCents: Math.max(row.refundedAmountCents, 0),
    currency: row.currency,
    canonicalStatus: resolvedCanonicalStatus(row),
    providerStatus: row.providerStatus ?? row.status,
    tenderType: row.tenderType ?? row.method,
    entryMethod: row.entryMethod,
    cardBrand: row.cardBrand,
    last4: row.last4,
    receiptUrl: row.receiptUrl,
    initiatedByMemberId: row.initiatedByMemberId,
    legacySource: row.legacySource,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  }));
}

async function listSquareAttemptsForAppointmentSummary(
  db: PaymentDatabase,
  appointmentId: string,
) {
  return db
    .select({
      id: paymentAttempts.id,
      status: paymentAttempts.status,
      expiresAt: paymentAttempts.expiresAt,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, appointmentId),
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt));
}

async function listSquareAttemptsForAppointments(appointmentIds: string[]) {
  const db = getDb();
  return db
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      status: paymentAttempts.status,
      expiresAt: paymentAttempts.expiresAt,
      createdAt: paymentAttempts.createdAt,
    })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.appointmentId, appointmentIds),
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt));
}

export type FinalTotalChangeDecision =
  | { ok: true }
  | {
      ok: false;
      code:
        | "owner_required_after_payment"
        | "change_reason_required"
        | "final_total_below_net_paid";
      message: string;
    };

export function validateFinalTotalChange(input: {
  currentFinalTotalCents: number | null;
  nextFinalTotalCents: number;
  paidTowardJobCents: number;
  hasSuccessfulPayment: boolean;
  actorRole: string | null | undefined;
  changeReason?: string | null;
}): FinalTotalChangeDecision {
  if (input.nextFinalTotalCents < input.paidTowardJobCents) {
    return {
      ok: false,
      code: "final_total_below_net_paid",
      message: "Final job total cannot be lower than the net amount paid.",
    };
  }
  if (
    input.currentFinalTotalCents === input.nextFinalTotalCents ||
    !input.hasSuccessfulPayment
  ) {
    return { ok: true };
  }
  if (input.actorRole?.trim().toLowerCase() !== "owner") {
    return {
      ok: false,
      code: "owner_required_after_payment",
      message:
        "Only the owner can change the final job total after a successful payment.",
    };
  }
  if (!input.changeReason?.trim()) {
    return {
      ok: false,
      code: "change_reason_required",
      message:
        "A reason is required when changing the final job total after payment.",
    };
  }
  return { ok: true };
}

export async function getFinalTotalPaymentLock(
  db: PaymentDatabase,
  appointmentId: string,
  options?: PaymentLedgerSchemaOptions,
): Promise<{
  paidTowardJobCents: number;
  hasSuccessfulPayment: boolean;
}> {
  const rows = await listAppointmentPaymentRows(db, appointmentId, options);
  const hasSuccessfulPayment = rows.some((row) =>
    isProviderFinanciallyCompleted(row),
  );
  const summary = buildAppointmentPaymentSummary({
    jobTotalCents: null,
    entries: rows.map((row) => ({
      canonicalStatus: row.canonicalStatus,
      jobAmountCents: row.jobAmountCents,
      tipCents: row.tipCents,
      refundedAmountCents: row.refundedAmountCents,
      countTowardBalance: isProviderFinanciallyCompleted(row),
    })),
  });
  return {
    paidTowardJobCents: summary.paidTowardJobCents,
    hasSuccessfulPayment,
  };
}

export async function syncAppointmentCardTipCents(
  db: PaymentDatabase,
  appointmentId: string,
): Promise<number> {
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    const [appointment] = await db
      .select({ cardTipCents: appointments.cardTipCents })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    return Math.max(appointment?.cardTipCents ?? 0, 0);
  }

  const rows = await listAppointmentPaymentRows(db, appointmentId, {
    schemaAvailable: true,
  });
  const cardRows = rows.filter(
    (row) =>
      isProviderFinanciallyCompleted(row) &&
      (row.tenderType?.toLowerCase() === "card" ||
        row.provider === "square" ||
        row.provider === "stripe"),
  );
  const summary = buildAppointmentPaymentSummary({
    jobTotalCents: null,
    entries: cardRows.map((row) => ({
      canonicalStatus: row.canonicalStatus,
      jobAmountCents: row.jobAmountCents,
      tipCents: row.tipCents,
      refundedAmountCents: row.refundedAmountCents,
      countTowardBalance: isProviderFinanciallyCompleted(row),
    })),
  });
  await db
    .update(appointments)
    .set({ cardTipCents: summary.tipCents, updatedAt: new Date() })
    .where(eq(appointments.id, appointmentId));
  return summary.tipCents;
}

export async function expireStalePaymentAttempts(
  db: PaymentDatabase,
  now = new Date(),
): Promise<void> {
  if (!(await isPaymentLedgerSchemaAvailable(db))) return;

  await db
    .update(paymentAttempts)
    .set({ status: "expired", resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [...ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
        lte(paymentAttempts.expiresAt, now),
      ),
    );
}
