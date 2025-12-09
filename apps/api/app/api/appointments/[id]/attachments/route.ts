import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, appointmentAttachments, appointments } from "@/db";
import { isAdminRequest } from "../../../web/admin";

const AttachmentSchema = z.object({
  filename: z.string().min(1),
  url: z.string().url(),
  contentType: z.string().optional()
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = AttachmentSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
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
      filename: parsed.data.filename,
      url: parsed.data.url,
      contentType: parsed.data.contentType ?? null
    })
    .returning();

  if (!inserted) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

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
