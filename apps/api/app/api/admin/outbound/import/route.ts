import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, isNotNull } from "drizzle-orm";
import { contacts, crmPipeline, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { normalizePhone } from "../../../web/utils";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { recordAuditEvent, getAuditActorFromRequest } from "@/lib/audit";
import { resolveOrCreatePartnerAccount } from "@/lib/partner-accounts";

type OutboundRow = {
  company?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  website?: string;
  domain?: string;
  title?: string;
  industry?: string;
  companySize?: string;
  linkedinUrl?: string;
  city?: string;
  state?: string;
  zip?: string;
  sourceListName?: string;
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

function slugText(value: string | null): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueText(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
}

function classifyOutboundSegment(input: {
  campaign: string;
  company: string | null;
  title: string | null;
  industry: string | null;
  notes: string | null;
  sourceListName: string | null;
}): { segment: string | null; subsegment: string | null } {
  const haystack = slugText(
    [
      input.campaign,
      input.company,
      input.title,
      input.industry,
      input.notes,
      input.sourceListName,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (/(property manager|property management|community manager|apartment|multifamily|leasing)/.test(haystack)) {
    const subsegment = /apartment|multifamily|community/.test(haystack)
      ? "multifamily"
      : "property_management";
    return { segment: "property_manager", subsegment };
  }

  if (/(realtor|real estate|broker|listing agent|agent\b)/.test(haystack)) {
    const subsegment = /broker/.test(haystack) ? "brokerage" : "residential_agent";
    return { segment: "real_estate_agent", subsegment };
  }

  if (/(estate|probate|senior move|downsizing|organizer)/.test(haystack)) {
    const subsegment = /senior move|downsizing/.test(haystack)
      ? "senior_transition"
      : "estate_cleanout";
    return { segment: "estate_cleanout", subsegment };
  }

  if (/(investor|flipper|flip|wholesale|wholesaler)/.test(haystack)) {
    return { segment: "investor_flipper", subsegment: "residential_investor" };
  }

  if (/(contractor|construction|remodel|renovation|roofing|plumbing|restoration)/.test(haystack)) {
    return { segment: "contractor", subsegment: "trade_contractor" };
  }

  if (/(storage|facility manager|self storage)/.test(haystack)) {
    return { segment: "storage_facility", subsegment: "facility_manager" };
  }

  if (/(junk|haul|cleanout|removal)/.test(haystack)) {
    return { segment: "cleanout_referral", subsegment: "general_referral" };
  }

  if (input.campaign.trim().toLowerCase() === "property_management") {
    return { segment: "property_manager", subsegment: "property_management" };
  }

  return { segment: null, subsegment: null };
}

function buildAccountResearchNotes(input: {
  title: string | null;
  industry: string | null;
  companySize: string | null;
  linkedinUrl: string | null;
  notes: string | null;
  sourceListName: string | null;
}): string | null {
  const bits = uniqueText([
    input.title ? `Title: ${input.title}` : null,
    input.industry ? `Industry: ${input.industry}` : null,
    input.companySize ? `Company size: ${input.companySize}` : null,
    input.linkedinUrl ? `LinkedIn: ${input.linkedinUrl}` : null,
    input.sourceListName ? `Source list: ${input.sourceListName}` : null,
    input.notes,
  ]);
  return bits.length ? bits.join(" | ") : null;
}

function chooseOutboundTaskTitle(segment: string | null): string {
  switch (segment) {
    case "property_manager":
      return "Outbound: Call property manager";
    case "real_estate_agent":
      return "Outbound: Call realtor";
    case "estate_cleanout":
      return "Outbound: Call estate partner";
    case "investor_flipper":
      return "Outbound: Call investor";
    case "contractor":
      return "Outbound: Call contractor";
    case "storage_facility":
      return "Outbound: Call facility manager";
    default:
      return "Outbound: Call referral partner";
  }
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
    const title = normalizeText(row["title"]);
    const industry = normalizeText(row["industry"]);
    const companySize = normalizeText(row["companySize"]);
    const linkedinUrl = normalizeText(row["linkedinUrl"]);
    const sourceListName = normalizeText(row["sourceListName"]);
    const website = normalizeText(row["website"]);
    const domain = normalizeText(row["domain"]);
    const locationBits = [normalizeText(row["city"]), normalizeText(row["state"]), normalizeText(row["zip"])].filter(Boolean);
    const location = locationBits.length ? locationBits.join(", ") : null;
    const { segment, subsegment } = classifyOutboundSegment({
      campaign,
      company,
      title,
      industry,
      notes: notesExtra,
      sourceListName,
    });
    const researchNotes = buildAccountResearchNotes({
      title,
      industry,
      companySize,
      linkedinUrl,
      notes: notesExtra,
      sourceListName,
    });

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
            company: string | null;
            email: string | null;
            phone: string | null;
            phoneE164: string | null;
            source: string | null;
            partnerAccountId: string | null;
            partnerStatus: string;
            partnerOwnerMemberId: string | null;
          }
        | null = null;

      if (email) {
        const [found] = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            company: contacts.company,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source,
            partnerAccountId: contacts.partnerAccountId,
            partnerStatus: contacts.partnerStatus,
            partnerOwnerMemberId: contacts.partnerOwnerMemberId
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
            company: contacts.company,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source,
            partnerAccountId: contacts.partnerAccountId,
            partnerStatus: contacts.partnerStatus,
            partnerOwnerMemberId: contacts.partnerOwnerMemberId
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
            company: contacts.company,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            source: contacts.source,
            partnerAccountId: contacts.partnerAccountId,
            partnerStatus: contacts.partnerStatus,
            partnerOwnerMemberId: contacts.partnerOwnerMemberId
          })
          .from(contacts)
          .where(eq(contacts.phone, phone.raw))
          .limit(1);
        existing = found ?? null;
      }
      let partnerAccountId = existing?.partnerAccountId ?? null;
      if (!partnerAccountId) {
        const account = await resolveOrCreatePartnerAccount(tx as any, {
          name: company,
          website,
          domain: domain ?? email ?? null,
          segment,
          subsegment,
          city: normalizeText(row["city"]),
          state: normalizeText(row["state"]),
          source,
          sourceCampaign: campaign,
          sourceListName,
          ownerMemberId: assignee,
          notes: researchNotes,
        });
        partnerAccountId = account?.id ?? null;
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
        if (!existing.company && company) nextValues.company = company;
        if (!existing.source) nextValues.source = source;
        if (!existing.partnerAccountId && partnerAccountId) nextValues.partnerAccountId = partnerAccountId;
        if ((existing.source ?? "").startsWith("outbound:") || !existing.source) {
          if (existing.partnerStatus === "none") nextValues.partnerStatus = "prospect";
          if (!existing.partnerOwnerMemberId) nextValues.partnerOwnerMemberId = assignee ?? null;
        }
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
          company: company ?? null,
          email: email ?? null,
          phone: phone?.e164 ?? phone?.raw ?? null,
          phoneE164: phone?.e164 ?? null,
          salespersonMemberId: assignee,
          partnerAccountId,
          partnerStatus: "prospect",
          partnerOwnerMemberId: assignee ?? null,
          source,
          createdAt: now,
          updatedAt: now
        })
        .returning({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          source: contacts.source,
          partnerAccountId: contacts.partnerAccountId
        });

      if (!createdContact?.id) {
        throw new Error("contact_insert_failed");
      }

      created += 1;

      await tx.insert(crmPipeline).values({ contactId: createdContact.id, stage: "new", notes: null }).onConflictDoNothing({
        target: crmPipeline.contactId
      });

      const noteBits = [
        company ? `Company: ${company}` : null,
        title ? `Title: ${title}` : null,
        industry ? `Industry: ${industry}` : null,
        companySize ? `Company size: ${companySize}` : null,
        website ? `Website: ${website}` : null,
        linkedinUrl ? `LinkedIn: ${linkedinUrl}` : null,
        sourceListName ? `Source list: ${sourceListName}` : null,
        segment ? `Segment: ${segment}` : null,
        subsegment ? `Subsegment: ${subsegment}` : null,
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
      .select({ id: crmTasks.id, partnerAccountId: crmTasks.partnerAccountId })
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

    const contactPartnerAccountId = (contact as any)?.partnerAccountId as string | null | undefined;

    if (!existingTask?.id) {
      await db.insert(crmTasks).values({
        contactId,
        partnerAccountId: contactPartnerAccountId ?? null,
        title: chooseOutboundTaskTitle(segment),
        status: "open",
        dueAt: null,
        assignedTo: assignee,
        notes: buildOutboundNotes({ campaign, attempt: 1, company, notes: notesExtra })
      });
      tasksCreated += 1;
    } else if (!existingTask.partnerAccountId && contactPartnerAccountId) {
      await db
        .update(crmTasks)
        .set({ partnerAccountId: contactPartnerAccountId, updatedAt: now })
        .where(eq(crmTasks.id, existingTask.id));
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
