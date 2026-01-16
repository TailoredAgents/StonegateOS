import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, inArray, isNotNull } from "drizzle-orm";
import { contacts, conversationThreads, crmPipeline, crmTasks, getDb, leadAutomationStates } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const DISPOSITION_SET = [
  "spam",
  "not_a_lead",
  "out_of_state",
  "out_of_area",
  "do_not_contact",
  "bad_phone",
  "duplicate",
  "handled"
] as const;

type Disposition = (typeof DISPOSITION_SET)[number];

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITION_SET as readonly string[]).includes(value);
}

function titleForDisposition(value: Disposition): string {
  switch (value) {
    case "spam":
      return "Spam";
    case "not_a_lead":
      return "Not a lead";
    case "out_of_state":
      return "Out of state";
    case "out_of_area":
      return "Out of area";
    case "do_not_contact":
      return "Do not contact";
    case "bad_phone":
      return "Bad phone";
    case "duplicate":
      return "Duplicate";
    case "handled":
      return "Handled";
  }
}

function shouldMarkLost(value: Disposition): boolean {
  switch (value) {
    case "bad_phone":
      return false;
    default:
      return true;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const contactId = readString(payload?.["contactId"])?.trim() ?? "";
  const dispositionRaw = readString(payload?.["disposition"])?.trim().toLowerCase() ?? "";
  const detailRaw = readString(payload?.["detail"]);

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }
  if (!isDisposition(dispositionRaw)) {
    return NextResponse.json({ error: "invalid_disposition" }, { status: 400 });
  }

  const disposition = dispositionRaw;
  const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : null;

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
  const notes = [`disqualify=${disposition}`, "source=sales_disposition", detail ? `detail=${detail}` : null]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(" ");

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

    await tx
      .update(crmTasks)
      .set({ status: "completed", updatedAt: now })
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=follow_up%")
        )
      );

    await tx.insert(crmTasks).values({
      contactId,
      title: `Disqualified: ${titleForDisposition(disposition)}`,
      dueAt: null,
      assignedTo: actor.id ?? null,
      status: "completed",
      notes,
      createdAt: now,
      updatedAt: now
    });

    if (shouldMarkLost(disposition)) {
      await tx
        .insert(crmPipeline)
        .values({
          contactId,
          stage: "lost",
          notes: null,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: crmPipeline.contactId,
          set: { stage: "lost", updatedAt: now }
        });
    }

    if (disposition === "do_not_contact") {
      const leadRows = await tx
        .select({ leadId: conversationThreads.leadId })
        .from(conversationThreads)
        .where(eq(conversationThreads.contactId, contactId))
        .limit(25);

      const leadIds = leadRows
        .map((row) => row.leadId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      if (leadIds.length) {
        await tx
          .update(leadAutomationStates)
          .set({ dnc: true, followupState: "stopped", updatedAt: now })
          .where(inArray(leadAutomationStates.leadId, leadIds));
      }
    }
  });

  await recordAuditEvent({
    actor,
    action: "sales.disposition.set",
    entityType: "contact",
    entityId: contactId,
    meta: {
      disposition,
      detail,
      markLost: shouldMarkLost(disposition)
    }
  });

  return NextResponse.json({ ok: true });
}
