import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { contacts, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  const [row] = await db
    .update(contacts)
    .set({
      partnerReferralCount: sql`${contacts.partnerReferralCount} + 1`,
      partnerLastReferralAt: now,
      partnerLastTouchAt: sql`coalesce(${contacts.partnerLastTouchAt}, ${now})`,
      updatedAt: now
    })
    .where(eq(contacts.id, contactId))
    .returning({ id: contacts.id, count: contacts.partnerReferralCount });

  if (!row?.id) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "partner.referral_logged",
    entityType: "contact",
    entityId: contactId,
    meta: { at: now.toISOString() }
  });

  return NextResponse.json({ ok: true, contactId, at: now.toISOString() });
}

