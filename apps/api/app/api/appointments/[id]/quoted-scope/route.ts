import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAppointmentQuotedScope } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { areAppointmentMediaWritesEnabled } from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const BodySchema = z.object({
  quotedScopeText: z.string().max(4_000).nullable(),
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
    "appointment_media.manage",
  );
  if (permissionError) return permissionError;
  if (!areAppointmentMediaWritesEnabled()) {
    return NextResponse.json(
      { error: "appointment_media_writes_disabled" },
      { status: 503 },
    );
  }
  const parsed = BodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const quotedScopeText = await updateAppointmentQuotedScope({
      appointmentId,
      quotedScopeText: parsed.data.quotedScopeText,
    });
    await recordAuditEvent({
      actor,
      action: "appointment.quoted_scope.updated",
      entityType: "appointment",
      entityId: appointmentId,
      meta: { hasScope: Boolean(quotedScopeText) },
    });
    return NextResponse.json({ ok: true, quotedScopeText });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
