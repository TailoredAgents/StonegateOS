import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  contacts,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  leads,
  mergeSuggestions,
  properties,
  quotes,
  appointments
} from "@/db";

type ContactRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  createdAt: Date;
};

type ContactLeadRow = {
  propertyId: string;
  contactId: string;
  leadId: string;
  leadCreatedAt: Date;
  leadUpdatedAt: Date;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
  contactCreatedAt: Date;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

type ContactStats = {
  contact: ContactRow;
  leadCount: number;
  lastLeadAt: Date;
};

export type MergeContactsResult = {
  sourceContactId: string;
  targetContactId: string;
  updatedFields: string[];
  moved: {
    properties: number;
    leads: number;
    quotes: number;
    appointments: number;
    threads: number;
    participants: number;
    tasks: number;
    pipeline: number;
  };
};

export type ScanMergeSuggestionsResult = {
  scanned: number;
  created: number;
  skipped: number;
};

type ScanMergeSuggestionsOptions = {
  sinceDays?: number;
  limit?: number;
  minConfidence?: number;
};

const DEFAULT_SCAN_DAYS = 365;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MIN_CONFIDENCE = 60;

function normalizeValue(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lastFourDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4);
}

function scoreSimilarity(primary: ContactRow, secondary: ContactRow): { score: number; breakdown: Record<string, boolean> } {
  const breakdown: Record<string, boolean> = {
    sameLastName: false,
    sameFirstName: false,
    sameFirstInitial: false,
    sameEmail: false,
    samePhoneLast4: false
  };

  const primaryLast = normalizeValue(primary.lastName);
  const secondaryLast = normalizeValue(secondary.lastName);
  const primaryFirst = normalizeValue(primary.firstName);
  const secondaryFirst = normalizeValue(secondary.firstName);

  let score = 30;

  if (primaryLast && primaryLast === secondaryLast) {
    breakdown.sameLastName = true;
    score += 40;
  }

  if (primaryFirst && primaryFirst === secondaryFirst) {
    breakdown.sameFirstName = true;
    score += 20;
  } else if (primaryFirst && secondaryFirst && primaryFirst[0] === secondaryFirst[0]) {
    breakdown.sameFirstInitial = true;
    score += 10;
  }

  const primaryEmail = normalizeValue(primary.email ?? "");
  const secondaryEmail = normalizeValue(secondary.email ?? "");
  if (primaryEmail && primaryEmail === secondaryEmail) {
    breakdown.sameEmail = true;
    score += 15;
  }

  const primaryLast4 = lastFourDigits(primary.phoneE164 ?? primary.phone);
  const secondaryLast4 = lastFourDigits(secondary.phoneE164 ?? secondary.phone);
  if (primaryLast4 && primaryLast4 === secondaryLast4) {
    breakdown.samePhoneLast4 = true;
    score += 10;
  }

  return { score: Math.min(score, 100), breakdown };
}

function contactStrength(stats: ContactStats): number {
  let score = stats.leadCount * 2;
  if (stats.contact.email) score += 3;
  if (stats.contact.phoneE164) score += 3;
  if (stats.contact.phone) score += 1;
  const daysAgo = Math.max(0, Math.floor((Date.now() - stats.lastLeadAt.getTime()) / (1000 * 60 * 60 * 24)));
  const recencyBoost = Math.max(0, 5 - Math.floor(daysAgo / 30));
  score += recencyBoost;
  return score;
}

export async function scanMergeSuggestions(
  options: ScanMergeSuggestionsOptions = {}
): Promise<ScanMergeSuggestionsResult> {
  const db = getDb();
  const sinceDays = Math.max(1, Math.min(options.sinceDays ?? DEFAULT_SCAN_DAYS, 3650));
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SCAN_LIMIT, 1000));
  const minConfidence = Math.max(1, Math.min(options.minConfidence ?? DEFAULT_MIN_CONFIDENCE, 100));

  const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      propertyId: leads.propertyId,
      contactId: leads.contactId,
      leadId: leads.id,
      leadCreatedAt: leads.createdAt,
      leadUpdatedAt: leads.updatedAt,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      contactCreatedAt: contacts.createdAt,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(properties, eq(leads.propertyId, properties.id))
    .where(gte(leads.createdAt, sinceDate))
    .orderBy(desc(leads.updatedAt));

  const grouped = new Map<string, ContactLeadRow[]>();
  for (const row of rows as ContactLeadRow[]) {
    const list = grouped.get(row.propertyId) ?? [];
    list.push(row);
    grouped.set(row.propertyId, list);
  }

  const suggestions: Array<{
    sourceContactId: string;
    targetContactId: string;
    reason: string;
    confidence: number;
    meta: Record<string, unknown>;
  }> = [];

  for (const [propertyId, groupRows] of grouped.entries()) {
    const contactMap = new Map<string, ContactStats>();
    for (const row of groupRows) {
      const existing = contactMap.get(row.contactId);
      const lastLeadAt =
        row.leadUpdatedAt && row.leadUpdatedAt > row.leadCreatedAt
          ? row.leadUpdatedAt
          : row.leadCreatedAt;
      if (existing) {
        existing.leadCount += 1;
        if (lastLeadAt > existing.lastLeadAt) {
          existing.lastLeadAt = lastLeadAt;
        }
      } else {
        contactMap.set(row.contactId, {
          contact: {
            id: row.contactId,
            firstName: row.contactFirstName,
            lastName: row.contactLastName,
            email: row.contactEmail ?? null,
            phone: row.contactPhone ?? null,
            phoneE164: row.contactPhoneE164 ?? null,
            createdAt: row.contactCreatedAt
          },
          leadCount: 1,
          lastLeadAt
        });
      }
    }

    if (contactMap.size <= 1) {
      continue;
    }

    const contactStats = Array.from(contactMap.values());
    contactStats.sort((a, b) => {
      const scoreDiff = contactStrength(b) - contactStrength(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.contact.createdAt.getTime() - b.contact.createdAt.getTime();
    });

    const primary = contactStats[0];
    if (!primary) {
      continue;
    }

    for (const secondary of contactStats.slice(1)) {
      const { score, breakdown } = scoreSimilarity(primary.contact, secondary.contact);
      if (score < minConfidence) {
        continue;
      }

      suggestions.push({
        sourceContactId: secondary.contact.id,
        targetContactId: primary.contact.id,
        reason: "property_name_match",
        confidence: score,
        meta: {
          propertyId,
          addressLine1: groupRows[0]?.addressLine1 ?? "",
          city: groupRows[0]?.city ?? "",
          state: groupRows[0]?.state ?? "",
          postalCode: groupRows[0]?.postalCode ?? "",
          primaryLeadCount: primary.leadCount,
          secondaryLeadCount: secondary.leadCount,
          similarity: breakdown
        }
      });
    }
  }

  const limitedSuggestions = suggestions.slice(0, limit);
  let created = 0;

  for (const suggestion of limitedSuggestions) {
    const inserted = await db
      .insert(mergeSuggestions)
      .values({
        sourceContactId: suggestion.sourceContactId,
        targetContactId: suggestion.targetContactId,
        status: "pending",
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        meta: suggestion.meta,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .onConflictDoNothing()
      .returning({ id: mergeSuggestions.id });

    if (inserted.length > 0) {
      created += 1;
    }
  }

  return {
    scanned: suggestions.length,
    created,
    skipped: limitedSuggestions.length - created
  };
}

export async function mergeContacts(input: {
  sourceContactId: string;
  targetContactId: string;
}): Promise<MergeContactsResult> {
  const { sourceContactId, targetContactId } = input;
  if (sourceContactId === targetContactId) {
    throw new Error("same_contact");
  }

  const db = getDb();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        createdAt: contacts.createdAt
      })
      .from(contacts)
      .where(inArray(contacts.id, [sourceContactId, targetContactId]));

    const source = rows.find((row) => row.id === sourceContactId);
    const target = rows.find((row) => row.id === targetContactId);

    if (!source || !target) {
      throw new Error("contact_not_found");
    }

    const updates: Partial<ContactRow> = {};
    if (!target.email && source.email) {
      updates.email = source.email;
    }
    if (!target.phoneE164 && source.phoneE164) {
      updates.phoneE164 = source.phoneE164;
    }
    if (!target.phone && source.phone) {
      updates.phone = source.phone;
    }

    const updatedFields = Object.keys(updates);
    if (updatedFields.length > 0) {
      await tx
        .update(contacts)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(contacts.id, targetContactId));
    }

    const propertiesUpdated = await tx
      .update(properties)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(properties.contactId, sourceContactId))
      .returning({ id: properties.id });

    const leadsUpdated = await tx
      .update(leads)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(leads.contactId, sourceContactId))
      .returning({ id: leads.id });

    const quotesUpdated = await tx
      .update(quotes)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(quotes.contactId, sourceContactId))
      .returning({ id: quotes.id });

    const appointmentsUpdated = await tx
      .update(appointments)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(appointments.contactId, sourceContactId))
      .returning({ id: appointments.id });

    const threadsUpdated = await tx
      .update(conversationThreads)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(conversationThreads.contactId, sourceContactId))
      .returning({ id: conversationThreads.id });

    const participantsUpdated = await tx
      .update(conversationParticipants)
      .set({ contactId: targetContactId })
      .where(eq(conversationParticipants.contactId, sourceContactId))
      .returning({ id: conversationParticipants.id });

    const tasksUpdated = await tx
      .update(crmTasks)
      .set({ contactId: targetContactId, updatedAt: new Date() })
      .where(eq(crmTasks.contactId, sourceContactId))
      .returning({ id: crmTasks.id });

    const [targetPipeline] = await tx
      .select({ contactId: crmPipeline.contactId })
      .from(crmPipeline)
      .where(eq(crmPipeline.contactId, targetContactId))
      .limit(1);

    let pipelineCount = 0;
    if (targetPipeline) {
      const removed = await tx
        .delete(crmPipeline)
        .where(eq(crmPipeline.contactId, sourceContactId))
        .returning({ id: crmPipeline.contactId });
      pipelineCount = removed.length;
    } else {
      const updated = await tx
        .update(crmPipeline)
        .set({ contactId: targetContactId, updatedAt: new Date() })
        .where(eq(crmPipeline.contactId, sourceContactId))
        .returning({ id: crmPipeline.contactId });
      pipelineCount = updated.length;
    }

    await tx.delete(contacts).where(eq(contacts.id, sourceContactId));

    return {
      sourceContactId,
      targetContactId,
      updatedFields,
      moved: {
        properties: propertiesUpdated.length,
        leads: leadsUpdated.length,
        quotes: quotesUpdated.length,
        appointments: appointmentsUpdated.length,
        threads: threadsUpdated.length,
        participants: participantsUpdated.length,
        tasks: tasksUpdated.length,
        pipeline: pipelineCount
      }
    };
  });
}
