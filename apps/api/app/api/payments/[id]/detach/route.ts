import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, payments } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { syncAppointmentCardTipCents } from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const DetachPaymentSchema = z.object({
  reviewNote: z.string().trim().min(1).max(500),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;
  const actor = getAuditActorFromRequest(request);
  if (actor.role?.trim().toLowerCase() !== "owner") {
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  }

  const { id: paymentId } = await context.params;
  const parsed = DetachPaymentSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!paymentId || !parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: parsed.success
          ? "paymentId is required"
          : parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }
  const [currentPayment] = await db
    .select({
      id: payments.id,
      appointmentId: payments.appointmentId,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!currentPayment) {
    return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  }
  if (!currentPayment.appointmentId) {
    return NextResponse.json(
      { error: "payment_already_detached" },
      { status: 409 },
    );
  }
  const expectedAppointmentId = currentPayment.appointmentId;

  const detachedAt = new Date();
  const result = await db.transaction(async (tx) => {
    const [appointment] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.id, expectedAppointmentId))
      .limit(1)
      .for("update");
    if (!appointment) {
      return { kind: "association_changed" as const };
    }

    const [payment] = await tx
      .select({
        id: payments.id,
        appointmentId: payments.appointmentId,
        canonicalStatus: payments.canonicalStatus,
        metadata: payments.metadata,
      })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1)
      .for("update");
    if (!payment) return { kind: "not_found" as const };
    if (!payment.appointmentId) {
      return { kind: "already_detached" as const };
    }
    if (payment.appointmentId !== appointment.id) {
      return { kind: "association_changed" as const };
    }

    await tx
      .update(payments)
      .set({
        appointmentId: null,
        canonicalStatus: "needs_review",
        metadata: {
          ...(payment.metadata ?? {}),
          ownerDetachment: {
            detachedAt: detachedAt.toISOString(),
            detachedBy: actor.id ?? actor.label ?? "owner",
            reviewNote: parsed.data.reviewNote,
            previousAppointmentId: payment.appointmentId,
            previousCanonicalStatus: payment.canonicalStatus,
          },
        },
        updatedAt: detachedAt,
      })
      .where(eq(payments.id, payment.id));
    await syncAppointmentCardTipCents(tx, payment.appointmentId);
    return {
      kind: "detached" as const,
      paymentId: payment.id,
      previousAppointmentId: payment.appointmentId,
      previousCanonicalStatus: payment.canonicalStatus,
    };
  });
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  }
  if (result.kind === "already_detached") {
    return NextResponse.json(
      { error: "payment_already_detached" },
      { status: 409 },
    );
  }
  if (result.kind === "association_changed") {
    return NextResponse.json(
      {
        error: "payment_appointment_changed",
        message:
          "The payment appointment changed while it was being detached. Refresh and review it again.",
      },
      { status: 409 },
    );
  }

  await recordAuditEvent({
    actor,
    action: "payment.owner_detached_for_review",
    entityType: "payment",
    entityId: paymentId,
    meta: {
      ...result,
      reviewNote: parsed.data.reviewNote,
    },
  });
  return NextResponse.json({ ok: true, result });
}
