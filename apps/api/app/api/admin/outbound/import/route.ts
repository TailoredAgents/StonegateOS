import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, isNotNull } from "drizzle-orm";
import { contacts, crmPipeline, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { normalizePhone } from "../../../web/utils";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { recordAuditEvent, getAuditActorFromRequest } from "@/lib/audit";

type OutboundRow = {
  company?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function splitName(input: string | null): { firstName: string; lastName: string } | null {
  if (!input) return null;
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { firstName: parts[0] ?? "Contact", lastName: "PM" };
  const firstName = parts[0] ?? "Contact";
  const lastName = parts.slice(1).join(" ").trim() || "PM";
  return { firstName, lastName };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildOutboundNotes(input: { campaign: string; attempt: number; company?: string | null; notes?: string | null }): string {
  const lines = ["[outbound]", `kind=outbound`, `campaign=${input.campaign}`, `attempt=${input.attempt}`];
  if (input.company) lines.push(`company=${input.company.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  if (input.notes) lines.push(`notes=${input.notes.replace(/\s+/g, " ").trim().slice(0, 280)}`);
  return lines.join("\n");
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

  const rowsRaw = (payload as Record<string, unknown>)["rows"];
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    return NextResponse.json({ error: "rows_required" }, { status: 400 });
  }
  const campaignRaw = (payload as Record<string, unknown>)["campaign"];
  const campaign = typeof campaignRaw === "string" && campaignRaw.trim().length ? campaignRaw.trim() : "property_management";

  const assignedToRaw = (payload as Record<string, unknown>)["assignedToMemberId"];
  const assignedToMemberId =
    typeof assignedToRaw === "string" && assignedToRaw.trim().length && isUuid(assignedToRaw.trim())
      ? assignedToRaw.trim()
      : null;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);
  const assignee = assignedToMemberId ?? config.defaultAssigneeMemberId;
  const actor = getAuditActorFromRequest(request);

  const now = new Date();

  let created = 0;
  let updated = 0;
  let tasksCreated = 0;
  let skipped = 0;

  for (const raw of rowsRaw.slice(0, 2000)) {
    const row = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
    if (!row) {
      skipped += 1;
      continue;
    }

    const company = normalizeText(row["company"]);
    const contactName = normalizeText(row["contactName"]);
    const email = normalizeEmail(row["email"]);
    const phoneRaw = normalizeText(row["phone"]);
    const notesExtra = normalizeText(row["notes"]);
    const locationBits = [normalizeText(row["city"]), normalizeText(row["state"]), normalizeText(row["zip"])].filter(Boolean);
    const location = locationBits.length ? locationBits.join(", ") : null;

    let phone: { raw: string; e164: string } | null = null;
    if (phoneRaw) {
      try {
        phone = normalizePhone(phoneRaw);
      } catch {
        phone = null;
      }
    }

    if (!email && !phone?.e164) {
      skipped += 1;
      continue;
    }

    const baseName = splitName(contactName) ?? splitName(company) ?? { firstName: "Property", lastName: "Manager" };

    const source = `outbound:${campaign}`;

    const contact = await db.transaction(async (tx) => {
      let existing:
        | {
            id: string;
            firstName: string;
            lastName: string;
            email: string | null;
            phone: string | null;
            phoneE164: string | null;
            source: string | null;
          }
        | null = null;

      if (email) {
        const [found] = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source
          })
          .from(contacts)
          .where(eq(contacts.email, email))
          .limit(1);
        existing = found ?? null;
      }

      if (!existing && phone?.e164) {
        const [found] = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source
          })
          .from(contacts)
          .where(eq(contacts.phoneE164, phone.e164))
          .limit(1);
        existing = found ?? null;
      }

      if (!existing && phone?.raw) {
        const [found] = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source
          })
          .from(contacts)
          .where(eq(contacts.phone, phone.raw))
          .limit(1);
        existing = found ?? null;
      }

      if (existing) {
        const nextValues: Partial<typeof contacts.$inferInsert> = {};
        if (!existing.email && email) nextValues.email = email;
        if (!existing.phoneE164 && phone?.e164) {
          nextValues.phoneE164 = phone.e164;
          nextValues.phone = phone.e164;
        }
        if (!existing.phone && phone?.e164) {
          nextValues.phone = phone.e164;
        }
        if ((!existing.firstName || existing.firstName.toLowerCase() === "unknown contact") && baseName.firstName) {
          nextValues.firstName = baseName.firstName;
        }
        if ((!existing.lastName || existing.lastName.toLowerCase() === "unknown") && baseName.lastName) {
          nextValues.lastName = baseName.lastName;
        }
        if (!existing.source) nextValues.source = source;
        if (Object.keys(nextValues).length) {
          await tx.update(contacts).set({ ...nextValues, updatedAt: now }).where(eq(contacts.id, existing.id));
          updated += 1;
        } else {
          skipped += 1;
        }

        await tx
          .insert(crmPipeline)
          .values({ contactId: existing.id, stage: "new", notes: null })
          .onConflictDoNothing({ target: crmPipeline.contactId });

        return existing;
      }

      const [createdContact] = await tx
        .insert(contacts)
        .values({
          firstName: baseName.firstName,
          lastName: baseName.lastName,
          email: email ?? null,
          phone: phone?.e164 ?? phone?.raw ?? null,
          phoneE164: phone?.e164 ?? null,
          salespersonMemberId: assignee,
          source,
          createdAt: now,
          updatedAt: now
        })
        .returning({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone, phoneE164: contacts.phoneE164, source: contacts.source });

      if (!createdContact?.id) {
        throw new Error("contact_insert_failed");
      }

      created += 1;

      await tx.insert(crmPipeline).values({ contactId: createdContact.id, stage: "new", notes: null }).onConflictDoNothing({
        target: crmPipeline.contactId
      });

      const noteBits = [
        company ? `Company: ${company}` : null,
        location ? `Location: ${location}` : null,
        notesExtra ? `Notes: ${notesExtra}` : null
      ].filter(Boolean);
      if (noteBits.length) {
        await tx.insert(crmTasks).values({
          contactId: createdContact.id,
          title: "Note",
          status: "completed",
          notes: noteBits.join("\n"),
          dueAt: null,
          assignedTo: null
        });
      }

      return createdContact;
    });

    const contactId = (contact as any)?.id as string | undefined;
    if (!contactId) continue;

    // Create the first outbound task if none is currently open.
    const [existingTask] = await db
      .select({ id: crmTasks.id })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=outbound%")
        )
      )
      .limit(1);

    if (!existingTask?.id) {
      await db.insert(crmTasks).values({
        contactId,
        title: "Outbound: Call property manager",
        status: "open",
        dueAt: now,
        assignedTo: assignee,
        notes: buildOutboundNotes({ campaign, attempt: 1, company, notes: notesExtra })
      });
      tasksCreated += 1;
    }

    await recordAuditEvent({
      actor,
      action: "outbound.imported",
      entityType: "contact",
      entityId: contactId,
      meta: { campaign, source }
    });
  }

  return NextResponse.json({
    ok: true,
    campaign,
    assignedToMemberId: assignee,
    created,
    updated,
    tasksCreated,
    skipped
  });
}
