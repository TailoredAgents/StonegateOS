import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { callCoaching, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ callRecordId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const { callRecordId } = await context.params;
  if (!callRecordId || callRecordId.trim().length === 0) {
    return NextResponse.json({ error: "missing_call_record_id" }, { status: 400 });
  }

  const db = getDb();
  const id = callRecordId.trim();

  await db.delete(callCoaching).where(and(eq(callCoaching.callRecordId, id), eq(callCoaching.version, 1)));

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "call_coaching.deleted",
    entityType: "call_record",
    entityId: id
  });

  return NextResponse.json({ ok: true });
}

