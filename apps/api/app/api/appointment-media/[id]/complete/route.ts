import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { finalizeAppointmentMedia } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { areAppointmentMediaWritesEnabled } from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const BodySchema = z
  .object({
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .default({});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "appointment_media.capture",
  );
  if (permissionError) return permissionError;
  if (!areAppointmentMediaWritesEnabled()) {
    return NextResponse.json(
      { error: "appointment_media_writes_disabled" },
      { status: 503 },
    );
  }
  const parsed = BodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
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
    const media = await finalizeAppointmentMedia({
      mediaId,
      checksumSha256: parsed.data.checksumSha256,
    });
    await recordAuditEvent({
      actor,
      action: "appointment.media.ready",
      entityType: "appointment_media",
      entityId: mediaId,
      meta: { assetId: media.assetId },
    });
    return NextResponse.json({ ok: true, media });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
