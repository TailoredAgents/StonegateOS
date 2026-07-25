import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteAppointmentMedia,
  updateAppointmentMedia,
} from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { areAppointmentMediaWritesEnabled } from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const PatchSchema = z
  .object({
    caption: z.string().max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    isCover: z.boolean().optional(),
    appointmentId: z.string().uuid().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one change is required.",
  });

async function authorizeWrite(request: NextRequest): Promise<Response | null> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "appointment_media.manage",
  );
  if (permissionError) return permissionError;
  if (!areAppointmentMediaWritesEnabled()) {
    return NextResponse.json(
      { error: "appointment_media_writes_disabled" },
      { status: 503 },
    );
  }
  return null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authorizationError = await authorizeWrite(request);
  if (authorizationError) return authorizationError;
  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = PatchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { id: mediaId } = await context.params;
  if (!mediaId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const media = await updateAppointmentMedia({
      mediaId,
      ...parsed.data,
    });
    await recordAuditEvent({
      actor,
      action: "appointment.media.updated",
      entityType: "appointment_media",
      entityId: mediaId,
      meta: {
        fields: Object.keys(parsed.data),
        appointmentId: parsed.data.appointmentId,
      },
    });
    return NextResponse.json({ ok: true, media });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authorizationError = await authorizeWrite(request);
  if (authorizationError) return authorizationError;
  const { id: mediaId } = await context.params;
  if (!mediaId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const result = await deleteAppointmentMedia(mediaId);
    await recordAuditEvent({
      actor,
      action: "appointment.media.deleted",
      entityType: "appointment_media",
      entityId: mediaId,
      meta: { appointmentId: result.appointmentId, recoverableDays: 30 },
    });
    return NextResponse.json({ ok: true, deletedId: result.deletedId });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}

