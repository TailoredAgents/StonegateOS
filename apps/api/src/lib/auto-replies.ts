import { and, eq, sql } from "drizzle-orm";
import {
  automationSettings,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  leadAutomationStates,
  outboxEvents,
  properties
} from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  getServiceAreaPolicy,
  getTemplatesPolicy,
  isPostalCodeAllowed,
  normalizePostalCode,
  resolveTemplateForChannel
} from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

type AutomationMode = "draft" | "assist" | "auto";
type AutoReplyChannel = "sms" | "email";

type AutoReplyOutcome = {
  status: "processed" | "skipped";
  error?: string | null;
};

const AUTO_REPLY_MIN_DELAY_MS = 10_000;
const AUTO_REPLY_MAX_DELAY_MS = 30_000;

function resolveReplyChannel(inboundChannel: string | null | undefined): AutoReplyChannel | null {
  switch ((inboundChannel ?? "").toLowerCase()) {
    case "sms":
      return "sms";
    case "email":
      return "email";
    case "call":
      return "sms";
    default:
      return null;
  }
}

function randomDelayMs(): number {
  const min = AUTO_REPLY_MIN_DELAY_MS;
  const max = AUTO_REPLY_MAX_DELAY_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getAutomationMode(db: DbExecutor, channel: AutoReplyChannel): Promise<AutomationMode> {
  const [row] = await db
    .select({ mode: automationSettings.mode })
    .from(automationSettings)
    .where(eq(automationSettings.channel, channel))
    .limit(1);

  return (row?.mode ?? "draft") as AutomationMode;
}

async function getLeadAutomationState(
  db: DbExecutor,
  leadId: string,
  channel: AutoReplyChannel
): Promise<{ paused: boolean; dnc: boolean; humanTakeover: boolean } | null> {
  const [row] = await db
    .select({
      paused: leadAutomationStates.paused,
      dnc: leadAutomationStates.dnc,
      humanTakeover: leadAutomationStates.humanTakeover
    })
    .from(leadAutomationStates)
    .where(and(eq(leadAutomationStates.leadId, leadId), eq(leadAutomationStates.channel, channel)))
    .limit(1);

  return row ?? null;
}

async function ensureSystemParticipant(db: DbExecutor, threadId: string, createdAt: Date): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "system")
      )
    )
    .limit(1);

  if (existing?.id) {
    return existing.id;
  }

  const [created] = await db
    .insert(conversationParticipants)
    .values({
      threadId,
      participantType: "system",
      displayName: "Stonegate Assistant",
      createdAt
    })
    .returning({ id: conversationParticipants.id });

  return created?.id ?? null;
}

export async function handleInboundAutoReply(messageId: string): Promise<AutoReplyOutcome> {
  const db = getDb();
  const [row] = await db
    .select({
      messageId: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
      threadId: conversationThreads.id,
      threadSubject: conversationThreads.subject,
      leadId: conversationThreads.leadId,
      contactId: conversationThreads.contactId,
      propertyPostalCode: properties.postalCode,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164
    })
    .from(conversationMessages)
    .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
    .where(eq(conversationMessages.id, messageId))
    .limit(1);

  if (!row || !row.threadId) {
    console.warn("[auto-reply] inbound_not_found", { messageId });
    return { status: "skipped" };
  }

  const threadId = row.threadId;

  if (row.direction !== "inbound") {
    return { status: "skipped" };
  }

  const inboundChannel = row.channel ?? "sms";
  const replyChannel = resolveReplyChannel(inboundChannel);
  if (!replyChannel) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: { reason: "unsupported_channel", inboundChannel }
    });
    return { status: "skipped" };
  }

  const mode = await getAutomationMode(db, replyChannel);
  if (mode === "draft") {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: { reason: "mode_draft", channel: replyChannel }
    });
    return { status: "skipped" };
  }

  if (row.leadId) {
    const state = await getLeadAutomationState(db, row.leadId, replyChannel);
    if (state?.paused || state?.dnc || state?.humanTakeover) {
      await recordAuditEvent({
        actor: { type: "ai", label: "auto-reply" },
        action: "auto_reply.skipped",
        entityType: "conversation_message",
        entityId: row.messageId,
        meta: {
          reason: "lead_kill_switch",
          channel: replyChannel,
          paused: state.paused,
          dnc: state.dnc,
          humanTakeover: state.humanTakeover
        }
      });
      return { status: "skipped" };
    }
  }

  const toAddress =
    replyChannel === "sms"
      ? row.contactPhoneE164 ?? row.contactPhone ?? null
      : row.contactEmail ?? null;
  if (!toAddress) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: { reason: "missing_recipient", channel: replyChannel }
    });
    return { status: "skipped" };
  }

  const [existingAutoReply] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, threadId),
        eq(conversationMessages.direction, "outbound"),
        sql`${conversationMessages.metadata} ->> 'autoReplyToMessageId' = ${row.messageId}`
      )
    )
    .limit(1);

  if (existingAutoReply) {
    return { status: "processed" };
  }

  const [existingOutbound] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.threadId, threadId), eq(conversationMessages.direction, "outbound")))
    .limit(1);

  if (existingOutbound) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: { reason: "existing_outbound", channel: replyChannel }
    });
    return { status: "skipped" };
  }

  const templatesPolicy = await getTemplatesPolicy(db);
  const serviceArea = await getServiceAreaPolicy(db);
  const normalizedPostalCode = normalizePostalCode(row.propertyPostalCode ?? null);
  const isOutOfArea =
    normalizedPostalCode !== null && !isPostalCodeAllowed(normalizedPostalCode, serviceArea);
  const templateGroup = isOutOfArea ? templatesPolicy.out_of_area : templatesPolicy.first_touch;
  const template = resolveTemplateForChannel(templateGroup, {
    inboundChannel,
    replyChannel
  });
  if (!template) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: {
        reason: "missing_template",
        channel: replyChannel,
        outOfArea: isOutOfArea
      }
    });
    return { status: "skipped" };
  }

  const delayMs = randomDelayMs();
  const now = new Date();
  const subject =
    replyChannel === "email"
      ? row.threadSubject?.trim().length
        ? `Re: ${row.threadSubject}`
        : "Stonegate Junk Removal"
      : null;

  const created = await db.transaction(async (tx) => {
    const participantId = await ensureSystemParticipant(tx, threadId, now);

    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction: "outbound",
        channel: replyChannel,
        subject,
        body: template,
        toAddress,
        deliveryStatus: "queued",
        metadata: {
          autoReply: true,
          autoReplyToMessageId: row.messageId,
          autoReplyDelayMs: delayMs,
          inboundChannel,
          outOfArea: isOutOfArea || undefined
        },
        createdAt: now
      })
      .returning({ id: conversationMessages.id });

    if (!message?.id) {
      throw new Error("auto_reply_message_failed");
    }

    await tx
      .update(conversationThreads)
      .set({
        lastMessagePreview: template.slice(0, 140),
        lastMessageAt: now,
        updatedAt: now
      })
      .where(eq(conversationThreads.id, threadId));

    await tx.insert(outboxEvents).values({
      type: "message.send",
      payload: { messageId: message.id },
      nextAttemptAt: new Date(now.getTime() + delayMs),
      createdAt: now
    });

    return message;
  });

  await recordAuditEvent({
    actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.queued",
      entityType: "conversation_message",
      entityId: created.id,
    meta: {
      inboundMessageId: row.messageId,
      threadId,
      channel: replyChannel,
      delayMs
    }
  });

  return { status: "processed" };
}
