import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { contacts, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { DateTime } from "luxon";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { upsertPartnerCheckinTask } from "@/lib/partner-checkins";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDueAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const contactIdRaw = (payload as any).contactId;
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  if (!contactId || !isUuid(contactId)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const dueAtFromPayload = parseDueAt((payload as any).dueAt);
  const daysRaw = (payload as any).daysFromNow;
  const daysFromNow = typeof daysRaw === "number" && Number.isFinite(daysRaw) ? Math.max(0, Math.floor(daysRaw)) : null;

  const assignedToRaw = (payload as any).assignedToMemberId;
  const assignedToMemberId =
    typeof assignedToRaw === "string" && assignedToRaw.trim().length && isUuid(assignedToRaw.trim())
      ? assignedToRaw.trim()
      : null;

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  const [contact] = await db
    .select({
      id: contacts.id,
      partnerStatus: contacts.partnerStatus,
      ownerId: contacts.partnerOwnerMemberId,
      salespersonMemberId: contacts.salespersonMemberId
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact?.id) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const config = await getSalesScorecardConfig(db);
  const zone = config.timezone || "America/New_York";

  const dueAt =
    dueAtFromPayload ??
    DateTime.fromJSDate(now, { zone })
      .plus({ days: daysFromNow ?? 30 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();

  const assignedTo = assignedToMemberId ?? contact.ownerId ?? contact.salespersonMemberId ?? null;

  await db.update(contacts).set({
    partnerNextTouchAt: dueAt,
    updatedAt: now,
    partnerOwnerMemberId: sql`coalesce(${contacts.partnerOwnerMemberId}, ${assignedTo})`
  }).where(eq(contacts.id, contactId));

  const { taskId } = await upsertPartnerCheckinTask(db as any, { contactId, assignedTo, dueAt });

  await recordAuditEvent({
    actor,
    action: "partner.checkin_scheduled",
    entityType: "contact",
    entityId: contactId,
    meta: { dueAt: dueAt.toISOString(), taskId }
  });

  return NextResponse.json({
    ok: true,
    contactId,
    taskId,
    dueAt: dueAt.toISOString()
  });
}

