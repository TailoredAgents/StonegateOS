import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, payments, appointments } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }

  const appointmentInput =
    rawBody && typeof rawBody === "object" && "appointmentId" in rawBody
      ? (rawBody as Record<string, unknown>)["appointmentId"]
      : undefined;
  const appointmentId = typeof appointmentInput === "string" ? appointmentInput.trim() : null;

  if (!appointmentId) {
    return NextResponse.json({ error: "invalid_payload", message: "appointmentId is required" }, { status: 400 });
  }

  const db = getDb();
  const appointment = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!appointment.length) {
    return NextResponse.json({ error: "appointment_not_found" }, { status: 404 });
  }

  await db
    .update(payments)
    .set({ appointmentId, updatedAt: new Date() })
    .where(eq(payments.id, id));

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "payment.attached",
    entityType: "payment",
    entityId: id,
    meta: { appointmentId }
  });

  return NextResponse.json({ ok: true, appointmentId });
}
