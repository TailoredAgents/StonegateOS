import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { appointments, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const PatchSchema = z.object({
  quotedTotalCents: z.number().int().nonnegative().nullable().optional(),
  bookingDetails: z.unknown().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(
    request,
    "appointments.update",
  );
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = PatchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const bookingDetailsInput = parsed.data.bookingDetails;
  if (bookingDetailsInput === undefined) {
    return NextResponse.json(
      { error: "booking_details_required" },
      { status: 400 },
    );
  }

  const bookingDetails = parseAppointmentBookingDetails(bookingDetailsInput);
  if (!bookingDetails) {
    return NextResponse.json(
      { error: "invalid_booking_details" },
      { status: 400 },
    );
  }

  const quotedTotalCents =
    parsed.data.quotedTotalCents === undefined
      ? null
      : (parsed.data.quotedTotalCents ?? null);
  const quotedTotalError = validateQuotedTotalForBookingDetails(
    bookingDetails,
    quotedTotalCents,
  );
  if (quotedTotalError) {
    return NextResponse.json({ error: quotedTotalError }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [updated] = await db
    .update(appointments)
    .set({
      quotedTotalCents,
      bookingDetails,
      updatedAt: new Date(),
    })
    .where(eq(appointments.id, appointmentId))
    .returning({
      id: appointments.id,
      quotedTotalCents: appointments.quotedTotalCents,
      bookingDetails: appointments.bookingDetails,
    });

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "appointment.updated",
    entityType: "appointment",
    entityId: appointmentId,
    meta: {
      fields: ["quotedTotalCents", "bookingDetails"],
    },
  });

  return NextResponse.json({
    ok: true,
    appointment: {
      id: updated.id,
      quotedTotalCents: updated.quotedTotalCents ?? null,
      bookingDetails: updated.bookingDetails ?? null,
    },
  });
}
