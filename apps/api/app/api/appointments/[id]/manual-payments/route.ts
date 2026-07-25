import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, paymentAttempts, payments } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  AppointmentMediaError,
  getAppointmentScopeState,
} from "@/lib/appointment-media";
import {
  expireStalePaymentAttemptsForAppointment,
  getAppointmentPaymentSummary,
  UNRESOLVED_SQUARE_ATTEMPT_STATUSES,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const ManualPaymentSchema = z.object({
  clientRequestId: z.string().uuid(),
  tenderType: z.enum(["cash", "check"]),
  tipCents: z.number().int().nonnegative().max(10_000_000).default(0),
  note: z.string().trim().max(500).optional(),
});

function isUuid(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.collect");
  if (permissionError) return permissionError;
  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }

  const parsed = ManualPaymentSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { id: appointmentId } = await context.params;
  let scope;
  try {
    scope = await getAppointmentScopeState(appointmentId);
  } catch (error) {
    if (
      error instanceof AppointmentMediaError &&
      error.code === "appointment_not_found"
    ) {
      return NextResponse.json(
        { error: "appointment_not_found" },
        { status: 404 },
      );
    }
    console.error("[payments] appointment scope check failed", {
      appointmentId,
      error: String(error),
    });
    return NextResponse.json(
      { error: "appointment_scope_unavailable" },
      { status: 503 },
    );
  }
  if (scope.needsScope) {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message: "Add the quoted-to-remove summary before recording payment.",
      },
      { status: 409 },
    );
  }

  const actor = getAuditActorFromRequest(request);
  const providerPaymentId = `manual:${parsed.data.clientRequestId}`;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        finalTotalCents: appointments.finalTotalCents,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
      .for("update");
    if (!appointment) return { kind: "not_found" as const };
    const lockedScope = await getAppointmentScopeState(appointmentId, tx);
    if (lockedScope.needsScope) {
      return { kind: "scope_required" as const };
    }
    if (
      appointment.finalTotalCents == null ||
      appointment.finalTotalCents <= 0
    ) {
      return { kind: "total_required" as const };
    }
    await expireStalePaymentAttemptsForAppointment(tx, appointmentId, now);

    const [existing] = await tx
      .select({
        id: payments.id,
        appointmentId: payments.appointmentId,
        jobAmountCents: payments.jobAmountCents,
        tipCents: payments.tipCents,
        tenderType: payments.tenderType,
      })
      .from(payments)
      .where(
        and(
          eq(payments.provider, "manual"),
          eq(payments.providerPaymentId, providerPaymentId),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.appointmentId !== appointmentId ||
        existing.tipCents !== parsed.data.tipCents ||
        existing.tenderType !== parsed.data.tenderType
      ) {
        return { kind: "request_conflict" as const };
      }
      return {
        kind: "recorded" as const,
        id: existing.id,
        jobAmountCents: existing.jobAmountCents ?? 0,
        tipCents: existing.tipCents,
        reused: true,
      };
    }

    const [unresolvedSquareAttempt] = await tx
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.appointmentId, appointmentId),
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            ...UNRESOLVED_SQUARE_ATTEMPT_STATUSES,
          ]),
        ),
      )
      .limit(1);
    if (unresolvedSquareAttempt) {
      return {
        kind: "reconciliation_required" as const,
        attemptId: unresolvedSquareAttempt.id,
      };
    }

    const summary = await getAppointmentPaymentSummary(tx, appointmentId, {
      jobTotalCents: appointment.finalTotalCents,
      now,
    });
    // Once Square has been launched, the provider can still complete the
    // charge even when the browser callback is delayed. Recording cash/check
    // during that window could collect the same balance twice.
    if (summary.activeAttemptId) {
      return {
        kind: "verification_in_progress" as const,
        attemptId: summary.activeAttemptId,
      };
    }
    if (summary.balanceCents == null || summary.balanceCents <= 0) {
      return { kind: "already_paid" as const };
    }
    const totalAmountCents = summary.balanceCents + parsed.data.tipCents;
    const [payment] = await tx
      .insert(payments)
      .values({
        provider: "manual",
        providerPaymentId,
        amount: totalAmountCents,
        jobAmountCents: summary.balanceCents,
        tipCents: parsed.data.tipCents,
        totalAmountCents,
        refundedAmountCents: 0,
        currency: "USD",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "completed",
        method: parsed.data.tenderType,
        tenderType: parsed.data.tenderType,
        initiatedByMemberId: isUuid(actor.id) ? actor.id : null,
        appointmentId,
        metadata: {
          clientRequestId: parsed.data.clientRequestId,
          note: parsed.data.note ?? null,
        },
        paidAt: now,
        capturedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payments.id });
    if (!payment) throw new Error("manual_payment_create_failed");
    await tx
      .update(paymentAttempts)
      .set({
        status: "canceled",
        errorCode: "manual_payment_recorded",
        errorMessage: "The remaining balance was recorded as a manual payment.",
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentAttempts.appointmentId, appointmentId),
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            "created",
            "launched",
            "pending_verification",
          ]),
        ),
      );
    return {
      kind: "recorded" as const,
      id: payment.id,
      jobAmountCents: summary.balanceCents,
      tipCents: parsed.data.tipCents,
      reused: false,
    };
  });

  if (result.kind === "not_found") {
    return NextResponse.json(
      { error: "appointment_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "total_required") {
    return NextResponse.json(
      { error: "final_total_required" },
      { status: 409 },
    );
  }
  if (result.kind === "scope_required") {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message: "Add the quoted-to-remove summary before recording payment.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "already_paid") {
    return NextResponse.json(
      { error: "appointment_already_paid" },
      { status: 409 },
    );
  }
  if (result.kind === "request_conflict") {
    return NextResponse.json(
      { error: "payment_request_conflict" },
      { status: 409 },
    );
  }
  if (result.kind === "verification_in_progress") {
    return NextResponse.json(
      {
        error: "square_verification_in_progress",
        attemptId: result.attemptId,
        message:
          "Wait for the Square attempt to finish or expire before recording cash or check.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "reconciliation_required") {
    return NextResponse.json(
      {
        error: "square_reconciliation_required",
        attemptId: result.attemptId,
        message:
          "The previous Square attempt must be reviewed by an owner before cash or check can be recorded.",
      },
      { status: 409 },
    );
  }

  const summary = await getAppointmentPaymentSummary(db, appointmentId);
  await recordAuditEvent({
    actor,
    action: "payment.manual.recorded",
    entityType: "payment",
    entityId: result.id,
    meta: {
      appointmentId,
      tenderType: parsed.data.tenderType,
      jobAmountCents: result.jobAmountCents,
      tipCents: result.tipCents,
      reused: result.reused,
    },
  });
  return NextResponse.json({
    ok: true,
    paymentId: result.id,
    appointmentId,
    reused: result.reused,
    paymentSummary: summary,
  });
}
