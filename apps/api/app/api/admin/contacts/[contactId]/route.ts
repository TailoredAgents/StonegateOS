import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, contacts, crmTasks, instantQuotes } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { normalizePhone } from "../../../web/utils";
import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { setContactAssignee } from "@/lib/contact-assignees";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode = direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? (direct["cause"] as Record<string, unknown>) : null;
  const causeCode = cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { firstName, lastName, email, phone, preferredContactMethod, source, salespersonMemberId } = payload as Record<
    string,
    unknown
  >;

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (typeof firstName === "string") {
    const trimmed = firstName.trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ error: "first_name_required" }, { status: 400 });
    }
    updates["firstName"] = trimmed;
  }

  if (typeof lastName === "string") {
    const trimmed = lastName.trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ error: "last_name_required" }, { status: 400 });
    }
    updates["lastName"] = trimmed;
  }

  if (email !== undefined) {
    if (typeof email === "string" && email.trim().length > 0) {
      updates["email"] = email.trim();
    } else if (email === null || (typeof email === "string" && email.trim().length === 0)) {
      updates["email"] = null;
    } else {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
  }

  if (phone !== undefined) {
    if (typeof phone === "string" && phone.trim().length > 0) {
      try {
        const normalized = normalizePhone(phone);
        updates["phone"] = normalized.raw;
        updates["phoneE164"] = normalized.e164;
      } catch {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
    } else if (phone === null || (typeof phone === "string" && phone.trim().length === 0)) {
      updates["phone"] = null;
      updates["phoneE164"] = null;
    } else {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  if (typeof preferredContactMethod === "string") {
    updates["preferredContactMethod"] = preferredContactMethod.trim();
  }

  if (typeof source === "string") {
    updates["source"] = source.trim();
  }

  const salespersonUpdateRaw = salespersonMemberId;
  if (salespersonUpdateRaw !== undefined) {
    if (typeof salespersonUpdateRaw === "string") {
      const trimmed = salespersonUpdateRaw.trim();
      if (trimmed.length > 0 && !isUuid(trimmed)) {
        return NextResponse.json({ error: "invalid_salesperson" }, { status: 400 });
      }
      updates["salespersonMemberId"] = trimmed.length > 0 ? trimmed : null;
    } else if (salespersonUpdateRaw === null) {
      updates["salespersonMemberId"] = null;
    } else {
      return NextResponse.json({ error: "invalid_salesperson" }, { status: 400 });
    }
  }

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: "no_updates_provided" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  let updated:
    | {
        id: string;
        firstName: string;
        lastName: string;
        email: string | null;
        phone: string | null;
        phoneE164: string | null;
        preferredContactMethod: string | null;
        source: string | null;
        updatedAt: Date;
        salespersonMemberId?: string | null;
      }
    | undefined;

  try {
    const [row] = await db
      .update(contacts)
      .set(updates)
      .where(eq(contacts.id, contactId))
      .returning({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        preferredContactMethod: contacts.preferredContactMethod,
        source: contacts.source,
        updatedAt: contacts.updatedAt,
        salespersonMemberId: contacts.salespersonMemberId
      });
    updated = row;
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42703") {
      if ("salespersonMemberId" in updates) {
        const memberId = updates["salespersonMemberId"];
        delete updates["salespersonMemberId"];

        await setContactAssignee(db, {
          contactId,
          memberId: typeof memberId === "string" ? memberId : null,
          actorId: actor.id ?? null
        });
      }
      const [row] = await db
        .update(contacts)
        .set(updates)
        .where(eq(contacts.id, contactId))
        .returning({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          preferredContactMethod: contacts.preferredContactMethod,
          source: contacts.source,
          updatedAt: contacts.updatedAt
        });
      updated = row ? { ...row, salespersonMemberId: salespersonUpdateRaw === null ? null : typeof salespersonUpdateRaw === "string" ? salespersonUpdateRaw.trim() || null : null } : undefined;
    } else {
      throw error;
    }
  }

  if (!updated) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  if (salespersonUpdateRaw !== undefined) {
    const nextAssignee = updated.salespersonMemberId ?? null;
    await db
      .update(crmTasks)
      .set({ assignedTo: nextAssignee, updatedAt: new Date() })
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%[auto] leadId=%")
        )
      );
  }

  const changedFields = Object.keys(updates).filter((key) => key !== "updatedAt");

  await recordAuditEvent({
    actor,
    action: "contact.updated",
    entityType: "contact",
    entityId: updated.id,
    meta: { fields: changedFields }
  });

  return NextResponse.json({
    contact: {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      phone: updated.phone,
      phoneE164: updated.phoneE164,
      salespersonMemberId: updated.salespersonMemberId ?? null,
      preferredContactMethod: updated.preferredContactMethod,
      source: updated.source,
      updatedAt: updated.updatedAt.toISOString()
    }
  });
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const [existing] = await db
    .select({ id: contacts.id, phone: contacts.phone, phoneE164: contacts.phoneE164 })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const digitsSet = new Set<string>();
  const addDigits = (value: string | null | undefined) => {
    if (!value) return;
    const digits = value.replace(/[^0-9]/gu, "");
    if (!digits) return;
    digitsSet.add(digits);
    if (digits.length === 11 && digits.startsWith("1")) {
      digitsSet.add(digits.slice(1));
    }
    if (digits.length === 10) {
      digitsSet.add(`1${digits}`);
    }
  };

  addDigits(existing.phone);
  addDigits(existing.phoneE164);

  const phoneDigits = Array.from(digitsSet);

  const result = await db.transaction(async (tx) => {
    let deletedInstantQuotes = 0;
    if (phoneDigits.length > 0) {
      const normalizedPhone = sql<string>`regexp_replace(${instantQuotes.contactPhone}, '[^0-9]', '', 'g')`;
      const deletedRows = await tx
        .delete(instantQuotes)
        .where(inArray(normalizedPhone, phoneDigits))
        .returning({ id: instantQuotes.id });
      deletedInstantQuotes = deletedRows.length;
    }

    const [deletedContact] = await tx
      .delete(contacts)
      .where(eq(contacts.id, contactId))
      .returning({ id: contacts.id });

    if (!deletedContact?.id) {
      throw new Error("contact_not_found");
    }

    return { deletedInstantQuotes };
  });

  await recordAuditEvent({
    actor,
    action: "contact.deleted",
    entityType: "contact",
    entityId: contactId,
    meta: { deletedInstantQuotes: result.deletedInstantQuotes }
  });

  return NextResponse.json({ deleted: true, deletedInstantQuotes: result.deletedInstantQuotes });
}
