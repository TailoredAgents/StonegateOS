import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, appointmentNotes } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const NoteSchema = z.object({
  body: z.string().min(1).max(2000)
});

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

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = NoteSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const createdAt = new Date();

  const [note] = await db
    .insert(appointmentNotes)
    .values({
      appointmentId,
      body: parsed.data.body,
      createdAt
    })
    .returning({
      id: appointmentNotes.id,
      appointmentId: appointmentNotes.appointmentId,
      body: appointmentNotes.body,
      createdAt: appointmentNotes.createdAt
    });

  if (!note) {
    return NextResponse.json({ error: "note_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.note.created",
    entityType: "appointment_note",
    entityId: note.id,
    meta: { appointmentId }
  });

  return NextResponse.json({ ok: true, note });
}
