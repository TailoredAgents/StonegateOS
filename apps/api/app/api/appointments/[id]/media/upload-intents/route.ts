import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createAppointmentMediaUploadIntents,
  MAX_APPOINTMENT_MEDIA_BATCH,
} from "@/lib/appointment-media";
import {
  actorMemberId,
  appointmentMediaErrorResponse,
} from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  areAppointmentMediaWritesEnabled,
  isMobileOfflineMediaEnabled,
} from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

const BodySchema = z.object({
  uploadMode: z.enum(["offline_queue", "direct_mobile"]).optional(),
  quotedScopeText: z.string().max(4_000).optional(),
  files: z
    .array(
      z.object({
        clientId: z.string().uuid(),
        filename: z.string().trim().min(1).max(240),
        contentType: z.string().trim().min(1).max(100),
        byteLength: z.number().int().positive(),
        checksumSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
        caption: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(MAX_APPOINTMENT_MEDIA_BATCH),
});

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

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (parsed.data.quotedScopeText !== undefined) {
    const scopePermissionError = await requirePermission(
      request,
      "appointment_media.manage",
    );
    if (scopePermissionError) return scopePermissionError;
  }
  if (
    parsed.data.uploadMode === "offline_queue" &&
    !isMobileOfflineMediaEnabled()
  ) {
    return NextResponse.json(
      { error: "mobile_offline_media_disabled" },
      { status: 503 },
    );
  }

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const intents = await createAppointmentMediaUploadIntents({
      appointmentId,
      actorId: actorMemberId(actor.id),
      quotedScopeText: parsed.data.quotedScopeText,
      source:
        parsed.data.uploadMode === "offline_queue"
          ? "offline_mobile"
          : "direct_upload",
      files: parsed.data.files,
    });
    await recordAuditEvent({
      actor,
      action: "appointment.media.upload_intents.created",
      entityType: "appointment",
      entityId: appointmentId,
      meta: {
        count: intents.length,
        uploadMode: parsed.data.uploadMode ?? "direct_mobile",
        mediaIds: intents.map((intent) => intent.mediaId),
      },
    });
    return NextResponse.json({ ok: true, intents }, { status: 201 });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
