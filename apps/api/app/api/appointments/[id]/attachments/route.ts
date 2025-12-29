import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, appointments, appointmentAttachments } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const AttachmentSchema = z.object({
  filename: z.string().min(1),
  url: z.string().min(1),
  contentType: z.string().optional()
});

const MAX_BYTES = 20 * 1024 * 1024; // 20MB

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let filename: string | null = null;
  let url: string | null = null;
  let storedContentType: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const name = form.get("filename");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    filename = typeof name === "string" && name.trim().length ? name.trim() : file.name;
    storedContentType = file.type || "application/octet-stream";
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const base64 = buf.toString("base64");
    url = `data:${storedContentType};base64,${base64}`;
  } else {
    const payload = (await request.json().catch(() => null)) as unknown;
    const parsed = AttachmentSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_payload", message: parsed.error.flatten() },
        { status: 400 }
      );
    }
    filename = parsed.data.filename;
    url = parsed.data.url;
    storedContentType = parsed.data.contentType ?? null;

    if (url.startsWith("data:")) {
      const base64Part = url.split(",")[1] ?? "";
      const estimatedBytes = Math.ceil((base64Part.length * 3) / 4);
      if (estimatedBytes > MAX_BYTES) {
        return NextResponse.json({ error: "file_too_large" }, { status: 413 });
      }
    }
  }

  const db = getDb();
  const appt = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!appt.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [inserted] = await db
    .insert(appointmentAttachments)
    .values({
      appointmentId,
      filename: filename!,
      url: url!,
      contentType: storedContentType
    })
    .returning();

  if (!inserted) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.attachment.added",
    entityType: "appointment_attachment",
    entityId: inserted.id,
    meta: { appointmentId }
  });

  return NextResponse.json({
    ok: true,
    attachment: {
      id: inserted.id,
      filename: inserted.filename,
      url: inserted.url,
      contentType: inserted.contentType,
      createdAt: inserted.createdAt.toISOString()
    }
  });
}
