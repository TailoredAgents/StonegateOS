import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_APPOINTMENT_IMAGE_BYTES } from "@/lib/appointment-image";
import { stageAppointmentMediaProxyUpload } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { areAppointmentMediaWritesEnabled } from "@/lib/feature-flags";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

class UploadBodyHttpError extends Error {
  constructor(readonly status: 413 | 415) {
    super(
      status === 413
        ? "uploaded_image_size_invalid"
        : "content_encoding_not_supported",
    );
    this.name = "UploadBodyHttpError";
  }
}

async function readBoundedUploadBody(
  request: NextRequest,
  maxBytes: number,
): Promise<Buffer> {
  const rawLength = request.headers.get("content-length")?.trim();
  if (
    rawLength &&
    (!/^\d+$/u.test(rawLength) || Number(rawLength) > maxBytes)
  ) {
    throw new UploadBodyHttpError(413);
  }
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new UploadBodyHttpError(415);
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UploadBodyHttpError(413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function PUT(
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

  const { id: mediaId } = await context.params;
  if (!mediaId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = await readBoundedUploadBody(request, MAX_APPOINTMENT_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof UploadBodyHttpError) {
      const code =
        error.status === 413
          ? "uploaded_image_size_invalid"
          : "content_encoding_not_supported";
      return NextResponse.json({ error: code }, { status: error.status });
    }
    return NextResponse.json({ error: "upload_body_invalid" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  try {
    const upload = await stageAppointmentMediaProxyUpload({
      mediaId,
      bytes,
      declaredContentType: request.headers.get("content-type"),
    });
    await recordAuditEvent({
      actor,
      action: "appointment.media.staged",
      entityType: "appointment_media",
      entityId: mediaId,
      meta: {
        assetId: upload.assetId,
        byteLength: upload.byteLength,
        transport: "same_origin_proxy",
      },
    });
    return NextResponse.json({ ok: true, upload });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
