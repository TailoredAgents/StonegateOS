import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const contactId = readString(payload?.["contactId"])?.trim() ?? "";

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(crmTasks)
      .set({ status: "completed", updatedAt: now })
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=speed_to_lead%")
        )
      );

    const [nextFollowup] = await tx
      .select({ id: crmTasks.id })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=follow_up%")
        )
      )
      .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt), asc(crmTasks.id))
      .limit(1);

    if (nextFollowup?.id) {
      await tx.update(crmTasks).set({ status: "completed", updatedAt: now }).where(eq(crmTasks.id, nextFollowup.id));
    }
  });

  await recordAuditEvent({
    actor,
    action: "sales.touch.manual",
    entityType: "contact",
    entityId: contactId,
    meta: {}
  });

  return NextResponse.json({ ok: true });
}
