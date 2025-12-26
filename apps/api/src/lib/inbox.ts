import { and, desc, eq, inArray, or } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  leads,
  messageDeliveryEvents,
  outboxEvents
} from "@/db";
import { recordAuditEvent } from "@/lib/audit";

const OPEN_THREAD_STATUSES = ["open", "pending"] as const;

export type InboundChannel = "sms" | "email" | "dm" | "call" | "web";

export type InboundMessageInput = {
  channel: InboundChannel;
  body: string;
  subject?: string | null;
  fromAddress: string;
  toAddress?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  mediaUrls?: string[];
  metadata?: Record<string, unknown> | null;
  receivedAt?: Date;
  senderName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
};

type ContactMatch = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
};

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

function parseEmailAddress(value: string): { email: string; name: string | null } {
  const trimmed = value.trim();
  const match = /^(.*)<([^>]+)>$/.exec(trimmed);
  if (match) {
    const name = match[1]?.trim().replace(/^\"|\"$/g, "") ?? "";
    const email = match[2]?.trim().toLowerCase() ?? "";
    return { email, name: name.length > 0 ? name : null };
  }

  return { email: trimmed.toLowerCase(), name: null };
}

function normalizeName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() ?? "Unknown";
  const lastName = parts.join(" ") || "Contact";
  return { firstName, lastName };
}

function normalizePhone(input: string): { raw: string; e164: string } {
  const phone = parsePhoneNumberFromString(input, "US");
  if (!phone) {
    throw new Error("invalid_phone");
  }
  return {
    raw: input,
    e164: phone.number
  };
}

function resolveContactName(fallbackName: string | null | undefined): { firstName: string; lastName: string } {
  const cleaned = typeof fallbackName === "string" && fallbackName.trim().length > 0 ? fallbackName.trim() : "Unknown Contact";
  return normalizeName(cleaned);
}

async function findContactByPhone(
  db: DbExecutor,
  phoneE164: string,
  phoneRaw: string
): Promise<ContactMatch | null> {
  const [row] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(or(eq(contacts.phoneE164, phoneE164), eq(contacts.phone, phoneRaw)))
    .limit(1);

  return row ?? null;
}

async function findContactByEmail(db: DbExecutor, email: string): Promise<ContactMatch | null> {
  const [row] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(eq(contacts.email, email))
    .limit(1);

  return row ?? null;
}

async function createContact(input: {
  db: DbExecutor;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  source?: string;
}): Promise<ContactMatch> {
  const db = input.db;
  const [created] = await db
    .insert(contacts)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      phoneE164: input.phoneE164 ?? null,
      source: input.source ?? "inbound"
    })
    .returning({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    });

  if (!created) {
    throw new Error("contact_create_failed");
  }

  return created;
}

async function ensureContactEmail(
  db: DbExecutor,
  contact: ContactMatch,
  email: string
): Promise<ContactMatch> {
  if (contact.email && contact.email.toLowerCase() === email.toLowerCase()) {
    return contact;
  }

  if (contact.email) {
    return contact;
  }

  const [updated] = await db
    .update(contacts)
    .set({ email, updatedAt: new Date() })
    .where(eq(contacts.id, contact.id))
    .returning({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    });

  return updated ?? contact;
}

async function ensureContactPhone(
  db: DbExecutor,
  contact: ContactMatch,
  phoneRaw: string,
  phoneE164: string
): Promise<ContactMatch> {
  if (contact.phoneE164 && contact.phoneE164 === phoneE164) {
    return contact;
  }

  if (contact.phoneE164 || contact.phone) {
    return contact;
  }

  const [updated] = await db
    .update(contacts)
    .set({ phone: phoneRaw, phoneE164, updatedAt: new Date() })
    .where(eq(contacts.id, contact.id))
    .returning({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    });

  return updated ?? contact;
}

async function findLatestLeadForContact(
  db: DbExecutor,
  contactId: string
): Promise<{ leadId: string; propertyId: string } | null> {
  const [row] = await db
    .select({
      leadId: leads.id,
      propertyId: leads.propertyId
    })
    .from(leads)
    .where(eq(leads.contactId, contactId))
    .orderBy(desc(leads.updatedAt), desc(leads.createdAt))
    .limit(1);

  return row ?? null;
}

export async function recordInboundMessage(input: InboundMessageInput): Promise<{
  threadId: string;
  messageId: string;
  contactId: string;
  leadId: string | null;
  duplicate: boolean;
}> {
  const channel = input.channel;
  const db = getDb();
  const now = input.receivedAt ?? new Date();
  const mediaUrls =
    input.mediaUrls?.filter((url): url is string => typeof url === "string" && url.trim().length > 0) ?? [];
  const trimmedBody = input.body.trim();
  const body = trimmedBody.length > 0 ? trimmedBody : mediaUrls.length > 0 ? "Media message" : "Message received";

  const result = await db.transaction(async (tx) => {
    if (input.providerMessageId) {
      const [existing] = await tx
        .select({
          id: conversationMessages.id,
          threadId: conversationMessages.threadId
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.providerMessageId, input.providerMessageId))
        .limit(1);

      if (existing) {
        const [thread] = await tx
          .select({
            contactId: conversationThreads.contactId,
            leadId: conversationThreads.leadId
          })
          .from(conversationThreads)
          .where(eq(conversationThreads.id, existing.threadId))
          .limit(1);

        return {
          threadId: existing.threadId,
          messageId: existing.id,
          contactId: thread?.contactId ?? "",
          leadId: thread?.leadId ?? null,
          duplicate: true
        };
      }
    }

    let contact: ContactMatch | null = null;
    let resolvedFromAddress = input.fromAddress.trim();
    let senderName = input.senderName ?? null;

    if (channel === "sms" || channel === "call") {
      let normalized;
      try {
        normalized = normalizePhone(resolvedFromAddress);
      } catch (error) {
        throw new Error("invalid_phone");
      }
      contact = await findContactByPhone(tx, normalized.e164, normalized.raw);
      if (!contact) {
        const name = resolveContactName(senderName);
        contact = await createContact({
          db: tx,
          firstName: name.firstName,
          lastName: name.lastName,
          phone: normalized.raw,
          phoneE164: normalized.e164,
          source: channel
        });
      } else {
        contact = await ensureContactPhone(tx, contact, normalized.raw, normalized.e164);
      }
    } else if (channel === "email") {
      const parsed = parseEmailAddress(resolvedFromAddress);
      resolvedFromAddress = parsed.email;
      senderName = senderName ?? parsed.name;
      contact = await findContactByEmail(tx, parsed.email);
      if (!contact) {
        const name = resolveContactName(senderName);
        contact = await createContact({
          db: tx,
          firstName: name.firstName,
          lastName: name.lastName,
          email: parsed.email,
          source: "email"
        });
      } else {
        contact = await ensureContactEmail(tx, contact, parsed.email);
      }
    } else {
      const normalizedContactEmail =
        typeof input.contactEmail === "string" && input.contactEmail.trim().length > 0
          ? input.contactEmail.trim().toLowerCase()
          : null;
      const rawContactPhone =
        typeof input.contactPhone === "string" && input.contactPhone.trim().length > 0
          ? input.contactPhone.trim()
          : null;
      let normalizedContactPhone: { raw: string; e164: string } | null = null;
      if (rawContactPhone) {
        try {
          normalizedContactPhone = normalizePhone(rawContactPhone);
        } catch {
          normalizedContactPhone = null;
        }
      }

      if (normalizedContactEmail) {
        contact = await findContactByEmail(tx, normalizedContactEmail);
      }
      if (!contact && normalizedContactPhone) {
        contact = await findContactByPhone(tx, normalizedContactPhone.e164, normalizedContactPhone.raw);
      }

      if (!contact) {
        const name = resolveContactName(senderName);
        contact = await createContact({
          db: tx,
          firstName: name.firstName,
          lastName: name.lastName,
          email: normalizedContactEmail,
          phone: normalizedContactPhone?.raw ?? null,
          phoneE164: normalizedContactPhone?.e164 ?? null,
          source: "inbound"
        });
      } else {
        if (normalizedContactEmail) {
          contact = await ensureContactEmail(tx, contact, normalizedContactEmail);
        }
        if (normalizedContactPhone) {
          contact = await ensureContactPhone(tx, contact, normalizedContactPhone.raw, normalizedContactPhone.e164);
        }
      }
    }

    if (!contact) {
      throw new Error("contact_missing");
    }

    const threadFilters = [
      eq(conversationThreads.contactId, contact.id),
      eq(conversationThreads.channel, channel),
      inArray(conversationThreads.status, [...OPEN_THREAD_STATUSES])
    ];

    const [existingThread] = await tx
      .select({
        id: conversationThreads.id,
        leadId: conversationThreads.leadId
      })
      .from(conversationThreads)
      .where(and(...threadFilters))
      .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
      .limit(1);

    let threadId = existingThread?.id ?? null;
    let leadId = existingThread?.leadId ?? null;

    if (!threadId) {
      const lead = await findLatestLeadForContact(tx, contact.id);
      leadId = lead?.leadId ?? null;
      const [thread] = await tx
        .insert(conversationThreads)
        .values({
          contactId: contact.id,
          leadId,
          propertyId: lead?.propertyId ?? null,
          status: "open",
          channel,
          subject: input.subject ?? null,
          lastMessagePreview: body.slice(0, 140),
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now
        })
        .returning({ id: conversationThreads.id });
      threadId = thread?.id ?? null;
    }

    if (!threadId) {
      throw new Error("thread_create_failed");
    }

    const [participant] = await tx
      .select({ id: conversationParticipants.id, externalAddress: conversationParticipants.externalAddress })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.threadId, threadId),
          eq(conversationParticipants.participantType, "contact"),
          eq(conversationParticipants.contactId, contact.id)
        )
      )
      .limit(1);

    let participantId = participant?.id ?? null;
    if (!participantId) {
      const displayName = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
      const [createdParticipant] = await tx
        .insert(conversationParticipants)
        .values({
          threadId,
          participantType: "contact",
          contactId: contact.id,
          externalAddress: resolvedFromAddress,
          displayName: displayName || "Contact",
          createdAt: now
        })
        .returning({ id: conversationParticipants.id });
      participantId = createdParticipant?.id ?? null;
    } else if (!participant?.externalAddress && resolvedFromAddress) {
      await tx
        .update(conversationParticipants)
        .set({ externalAddress: resolvedFromAddress })
        .where(eq(conversationParticipants.id, participantId));
    }

    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction: "inbound",
        channel,
        subject: input.subject ?? null,
        body,
        mediaUrls,
        toAddress: input.toAddress ?? null,
        fromAddress: resolvedFromAddress,
        deliveryStatus: "delivered",
        provider: input.provider ?? null,
        providerMessageId: input.providerMessageId ?? null,
        receivedAt: now,
        metadata: input.metadata ?? null,
        createdAt: now
      })
      .returning({ id: conversationMessages.id });

    if (!message?.id) {
      throw new Error("message_create_failed");
    }

    await tx
      .update(conversationThreads)
      .set({
        lastMessagePreview: body.slice(0, 140),
        lastMessageAt: now,
        updatedAt: now
      })
      .where(eq(conversationThreads.id, threadId));

    await tx.insert(messageDeliveryEvents).values({
      messageId: message.id,
      status: "delivered",
      detail: "inbound",
      provider: input.provider ?? null,
      occurredAt: now
    });

    await tx.insert(outboxEvents).values({
      type: "message.received",
      payload: {
        messageId: message.id,
        threadId,
        channel
      },
      createdAt: now
    });

    return {
      threadId,
      messageId: message.id,
      contactId: contact.id,
      leadId,
      duplicate: false
    };
  });

  if (!result.duplicate) {
    await recordAuditEvent({
      actor: { type: "system", label: input.provider ?? "inbound" },
      action: "message.received",
      entityType: "conversation_message",
      entityId: result.messageId,
      meta: {
        threadId: result.threadId,
        channel,
        from: input.fromAddress,
        to: input.toAddress ?? null
      }
    });
  }

  return result;
}
