import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb } from "@/db";
import {
  expireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt,
  getFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { recalculateAppointmentCommissionsAndRefreshDraftPayouts } from "@/lib/commissions";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const FinalTotalSchema = z.object({
  finalTotalCents: z.number().int().nonnegative(),
  changeReason: z.string().trim().min(1).max(500).optional(),
});

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.collect");
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  const parsed = FinalTotalSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        finalTotalCents: appointments.finalTotalCents,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
      .for("update");
    if (!appointment) return { kind: "not_found" as const };

    if (appointment.finalTotalCents !== parsed.data.finalTotalCents) {
      await expireStalePaymentAttemptsForAppointment(tx, appointmentId);
      const blockingAttempt = await getBlockingSquareAttempt(tx, appointmentId);
      if (blockingAttempt) {
        return {
          kind: "attempt_blocked" as const,
          attemptId: blockingAttempt.id,
          attemptStatus: blockingAttempt.status,
        };
      }
    }

    const paymentLock = await getFinalTotalPaymentLock(tx, appointmentId);
    const decision = validateFinalTotalChange({
      currentFinalTotalCents: appointment.finalTotalCents,
      nextFinalTotalCents: parsed.data.finalTotalCents,
      paidTowardJobCents: paymentLock.paidTowardJobCents,
      hasSuccessfulPayment: paymentLock.hasSuccessfulPayment,
      actorRole: actor.role,
      changeReason: parsed.data.changeReason,
    });
    if (!decision.ok) {
      return { kind: "rejected" as const, decision };
    }

    if (appointment.finalTotalCents !== parsed.data.finalTotalCents) {
      await tx
        .update(appointments)
        .set({
          finalTotalCents: parsed.data.finalTotalCents,
          updatedAt: new Date(),
        })
        .where(eq(appointments.id, appointmentId));
    }
    return {
      kind: "updated" as const,
      previousFinalTotalCents: appointment.finalTotalCents,
      status: appointment.status,
      paymentLock,
    };
  });

  if (result.kind === "not_found") {
    return NextResponse.json(
      { error: "appointment_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "attempt_blocked") {
    const reconciliationRequired = requiresSquareAttemptReconciliation(
      result.attemptStatus,
    );
    return NextResponse.json(
      {
        error: reconciliationRequired
          ? "square_reconciliation_required"
          : "square_verification_in_progress",
        attemptId: result.attemptId,
        message: reconciliationRequired
          ? "An unresolved Square attempt must be reviewed by an owner before changing the final total."
          : "Finish or reconcile the active Square attempt before changing the final total.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "rejected") {
    return NextResponse.json(
      {
        error: result.decision.code,
        message: result.decision.message,
      },
      {
        status:
          result.decision.code === "owner_required_after_payment" ? 403 : 409,
      },
    );
  }

  if (
    result.status === "completed" &&
    result.previousFinalTotalCents !== parsed.data.finalTotalCents
  ) {
    await recalculateAppointmentCommissionsAndRefreshDraftPayouts(
      db,
      appointmentId,
    );
  }
  await recordAuditEvent({
    actor,
    action: "appointment.final_total.updated",
    entityType: "appointment",
    entityId: appointmentId,
    meta: {
      previousFinalTotalCents: result.previousFinalTotalCents,
      finalTotalCents: parsed.data.finalTotalCents,
      paidTowardJobCents: result.paymentLock.paidTowardJobCents,
      paymentLocked: result.paymentLock.hasSuccessfulPayment,
      changeReason: parsed.data.changeReason ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    appointmentId,
    finalTotalCents: parsed.data.finalTotalCents,
  });
}
