import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { resolveLegacyStripePayment } from "@/lib/payment-reconciliation";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const AttachPaymentSchema = z.object({
  appointmentId: z.string().uuid(),
  jobAmountCents: z.number().int().nonnegative().max(100_000_000),
  tipCents: z.number().int().nonnegative().max(10_000_000),
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
  const parsed = AttachPaymentSchema.safeParse(
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
  const resolution = await resolveLegacyStripePayment({
    db,
    paymentId,
    appointmentId: parsed.data.appointmentId,
    jobAmountCents: parsed.data.jobAmountCents,
    tipCents: parsed.data.tipCents,
    reviewNote: parsed.data.reviewNote,
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

  await recordAuditEvent({
    actor,
    action: "payment.stripe.owner_resolved",
    entityType: "payment",
    entityId: paymentId,
    meta: {
      ...resolution,
      reviewNote: parsed.data.reviewNote,
    },
  });

  return NextResponse.json({ ok: true, resolution });
}
