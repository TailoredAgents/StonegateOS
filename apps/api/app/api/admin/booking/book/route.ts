import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb, appointments, outboxEvents, properties } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
function parseDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type BookRequest = {
  contactId?: string;
  propertyId?: string;
  startAt?: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
};

const PLACEHOLDER_CITY = "Unknown";
const PLACEHOLDER_STATE = "NA";
const PLACEHOLDER_POSTAL_CODE = "00000";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "bookings.manage");
  if (permissionError) return permissionError;

  let payload: BookRequest = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = (await request.json().catch(() => ({}))) as BookRequest;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    payload = {
      contactId: form.get("contactId")?.toString(),
      propertyId: form.get("propertyId")?.toString(),
      startAt: form.get("startAt")?.toString(),
      durationMinutes: form.get("durationMinutes") ? Number(form.get("durationMinutes")) : undefined,
      travelBufferMinutes: form.get("travelBufferMinutes") ? Number(form.get("travelBufferMinutes")) : undefined,
      services: form.get("services")
        ? form
            .get("services")!
            .toString()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    };
  }

  const contactId = typeof payload.contactId === "string" && payload.contactId.length ? payload.contactId : null;
  const propertyId = typeof payload.propertyId === "string" && payload.propertyId.length ? payload.propertyId : null;
  const startAtIso = typeof payload.startAt === "string" && payload.startAt.length ? payload.startAt : null;
  const durationMinutes =
    typeof payload.durationMinutes === "number" && payload.durationMinutes > 0 ? payload.durationMinutes : 60;
  const travelBufferMinutes =
    typeof payload.travelBufferMinutes === "number" && payload.travelBufferMinutes >= 0
      ? payload.travelBufferMinutes
      : 30;

  if (!contactId || !startAtIso) {
    return NextResponse.json({ error: "contact_and_start_required" }, { status: 400 });
  }

  const startAt = parseDate(startAtIso);
  if (!startAt) {
    return NextResponse.json({ error: "invalid_startAt" }, { status: 400 });
  }

  const services =
    Array.isArray(payload.services) && payload.services.length
      ? payload.services.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      let resolvedPropertyId = propertyId;
      let createdPropertyId: string | null = null;

      if (!resolvedPropertyId) {
        const short = contactId.split("-")[0] ?? contactId.slice(0, 8);
        const [created] = await tx
          .insert(properties)
          .values({
            contactId,
            addressLine1: `[Manual booking ${short}] Address pending`,
            addressLine2: null,
            city: PLACEHOLDER_CITY,
            state: PLACEHOLDER_STATE,
            postalCode: PLACEHOLDER_POSTAL_CODE,
            gated: false,
            createdAt: now,
            updatedAt: now
          })
          .returning({ id: properties.id });
        createdPropertyId = created?.id ?? null;
        resolvedPropertyId = createdPropertyId;
      }

      if (!resolvedPropertyId) {
        throw new Error("property_create_failed");
      }

      const [appt] = await tx
        .insert(appointments)
        .values({
          contactId,
          propertyId: resolvedPropertyId,
          startAt,
          durationMinutes,
          travelBufferMinutes,
          status: "confirmed",
          rescheduleToken: nanoid(24),
          type: "estimate"
        })
        .returning({ id: appointments.id });

      if (!appt?.id) {
        throw new Error("appointment_create_failed");
      }

      await tx.insert(outboxEvents).values({
        type: "estimate.requested",
        payload: {
          appointmentId: appt.id,
          services
        }
      });

      return { appointmentId: appt.id, createdPropertyId, propertyId: resolvedPropertyId };
    });

    if (result.createdPropertyId) {
      await recordAuditEvent({
        actor,
        action: "property.created",
        entityType: "property",
        entityId: result.createdPropertyId,
        meta: { contactId, placeholder: true, source: "manual_booking" }
      });
    }

    await recordAuditEvent({
      actor,
      action: "appointment.booked",
      entityType: "appointment",
      entityId: result.appointmentId,
      meta: {
        contactId,
        propertyId: result.propertyId,
        startAt: startAt.toISOString(),
        durationMinutes,
        travelBufferMinutes,
        services,
        source: "manual_booking"
      }
    });

    return NextResponse.json({
      ok: true,
      appointmentId: result.appointmentId,
      propertyId: result.propertyId,
      createdPlaceholderProperty: Boolean(result.createdPropertyId),
      startAt: startAt.toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "booking_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }


}
