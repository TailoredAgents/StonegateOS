import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { restoreAppointmentMedia } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { areAppointmentMediaWritesEnabled } from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id: mediaId } = await context.params;
  if (!mediaId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const media = await restoreAppointmentMedia(mediaId);
    await recordAuditEvent({
      actor,
      action: "appointment.media.restored",
      entityType: "appointment_media",
      entityId: mediaId,
      meta: { recoverableDays: 30 },
    });
    return NextResponse.json({ ok: true, media });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
