import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, payments } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  await db
    .update(payments)
    .set({ appointmentId: null, updatedAt: new Date() })
    .where(eq(payments.id, id));

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "payment.detached",
    entityType: "payment",
    entityId: id
  });

  return NextResponse.json({ ok: true });
}
