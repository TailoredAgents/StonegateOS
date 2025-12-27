import { DateTime } from "luxon";
import { and, asc, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import {
  appointments,
  automationSettings,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  leads,
  leadAutomationStates,
  outboxEvents,
  properties
} from "@/db";
import { deleteCalendarEvent } from "@/lib/calendar";
import { recordAuditEvent } from "@/lib/audit";
import {
  getConfirmationLoopPolicy,
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
const CONFIRMATION_REPLY_GRACE_MS = 12 * 60 * 60 * 1000;
const APPOINTMENT_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ??
  process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
  "America/New_York";

function resolveCandidateChannels(inboundChannel: string): AutoReplyChannel[] {
  switch (inboundChannel.toLowerCase()) {
    case "sms":
      return ["sms"];
    case "call":
      return ["sms"];
    case "email":
    case "dm":
    case "web":
      return ["sms", "email"];
    default:
      return ["sms", "email"];
  }
}

function randomDelayMs(): number {
  const min = AUTO_REPLY_MIN_DELAY_MS;
  const max = AUTO_REPLY_MAX_DELAY_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

type ConfirmationIntent = "confirm" | "decline";

function parseConfirmationIntent(body: string): ConfirmationIntent | null {
  const normalized = body.trim().toLowerCase();
  if (!normalized) return null;
  if (/\b(stop|unsubscribe)\b/.test(normalized)) return null;

  const cleaned = normalized.replace(/[^\w\s]/g, " ").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const declineTokens = new Set(["no", "nope", "nah", "cancel", "reschedule"]);
  const confirmTokens = new Set(["yes", "yep", "yeah", "y", "ok", "okay", "sure", "confirm", "confirmed"]);

  if (tokens.some((token) => declineTokens.has(token))) return "decline";
  if (tokens.some((token) => confirmTokens.has(token))) return "confirm";
  return null;
}

function buildRescheduleUrlForAppointment(appointmentId: string, token: string): string {
  const base =
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    process.env["SITE_URL"] ??
    "http://localhost:3000";
  const url = new URL("/schedule", base);
  url.searchParams.set("appointmentId", appointmentId);
  url.searchParams.set("token", token);
  return url.toString();
}

function formatAppointmentTime(date: Date): string {
  const dt = DateTime.fromJSDate(date, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE);
  if (!dt.isValid) {
    return date.toISOString();
  }
  return dt.toLocaleString(DateTime.DATETIME_MED);
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

async function queueThreadMessage(input: {
  db: DbExecutor;
  threadId: string;
  channel: AutoReplyChannel;
  toAddress: string;
  body: string;
  subject?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}): Promise<string | null> {
  const participantId = await ensureSystemParticipant(input.db, input.threadId, input.createdAt);

  const [message] = await input.db
    .insert(conversationMessages)
    .values({
      threadId: input.threadId,
      participantId,
      direction: "outbound",
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      toAddress: input.toAddress,
      deliveryStatus: "queued",
      metadata: input.metadata ?? null,
      createdAt: input.createdAt
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) {
    return null;
  }

  await input.db
    .update(conversationThreads)
    .set({
      lastMessagePreview: input.body.slice(0, 140),
      lastMessageAt: input.createdAt,
      updatedAt: input.createdAt
    })
    .where(eq(conversationThreads.id, input.threadId));

  await input.db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: input.createdAt
  });

  return message.id;
}

async function handleConfirmationReply(input: {
  db: DbExecutor;
  messageId: string;
  threadId: string;
  leadId: string | null;
  contactId: string | null;
  channel: string;
  body: string;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
}): Promise<boolean> {
  const confirmationPolicy = await getConfirmationLoopPolicy(input.db);
  if (!confirmationPolicy.enabled) {
    return false;
  }

  const intent = parseConfirmationIntent(input.body);
  if (!intent) {
    return false;
  }

  const now = new Date();
  const maxWindowMinutes =
    confirmationPolicy.windowsMinutes.length > 0
      ? Math.max(...confirmationPolicy.windowsMinutes)
      : 24 * 60;
  const windowStart = new Date(now.getTime() - CONFIRMATION_REPLY_GRACE_MS);
  const windowEnd = new Date(now.getTime() + (maxWindowMinutes * 60_000 + CONFIRMATION_REPLY_GRACE_MS));

  const filters = [
    isNotNull(appointments.startAt),
    gte(appointments.startAt, windowStart),
    lte(appointments.startAt, windowEnd),
    ne(appointments.status, "canceled"),
    ne(appointments.status, "completed"),
    ne(appointments.status, "no_show")
  ];

  if (input.leadId) {
    filters.push(eq(appointments.leadId, input.leadId));
  } else if (input.contactId) {
    filters.push(eq(appointments.contactId, input.contactId));
  } else {
    return false;
  }

  const [appointment] = await input.db
    .select({
      id: appointments.id,
      startAt: appointments.startAt,
      status: appointments.status,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId,
      leadId: appointments.leadId
    })
    .from(appointments)
    .where(and(...filters))
    .orderBy(asc(appointments.startAt))
    .limit(1);

  if (!appointment?.id || !appointment.startAt || !appointment.rescheduleToken) {
    return false;
  }

  const channel = input.channel.toLowerCase();
  const replyChannel = channel === "email" ? "email" : "sms";
  const toAddress =
    replyChannel === "email"
      ? input.contactEmail
      : input.contactPhoneE164 ?? input.contactPhone ?? null;

  if (intent === "confirm") {
    await input.db
      .update(appointments)
      .set({ status: "confirmed", updatedAt: now })
      .where(eq(appointments.id, appointment.id));

    if (appointment.leadId) {
      await input.db.update(leads).set({ status: "scheduled" }).where(eq(leads.id, appointment.leadId));
    }

    await input.db
      .delete(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, "estimate.reminder"),
          sql`(payload->>'appointmentId') = ${appointment.id}`
        )
      );

    if (toAddress) {
      const when = appointment.startAt instanceof Date ? formatAppointmentTime(appointment.startAt) : "soon";
      const body = `Thanks! You're confirmed for ${when}. Reply if you need any changes.`;

      const state =
        input.leadId && replyChannel
          ? await getLeadAutomationState(input.db, input.leadId, replyChannel)
          : null;
      if (!state?.paused && !state?.dnc && !state?.humanTakeover) {
        await queueThreadMessage({
          db: input.db,
          threadId: input.threadId,
          channel: replyChannel,
          toAddress,
          body,
          metadata: {
            confirmationLoop: true,
            confirmationIntent: "confirm",
            appointmentId: appointment.id
          },
          createdAt: now
        });
      }
    }

    await recordAuditEvent({
      actor: { type: "ai", label: "confirmation-loop" },
      action: "appointment.confirmed",
      entityType: "appointment",
      entityId: appointment.id,
      meta: { messageId: input.messageId, channel }
    });

    return true;
  }

  if (intent === "decline") {
    await input.db
      .update(appointments)
      .set({ status: "requested", updatedAt: now, calendarEventId: null })
      .where(eq(appointments.id, appointment.id));

    if (appointment.leadId) {
      await input.db.update(leads).set({ status: "contacted" }).where(eq(leads.id, appointment.leadId));
    }

    if (appointment.calendarEventId) {
      await deleteCalendarEvent(appointment.calendarEventId);
    }

    await input.db
      .delete(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, "estimate.reminder"),
          sql`(payload->>'appointmentId') = ${appointment.id}`
        )
      );

    if (toAddress) {
      const rescheduleUrl = buildRescheduleUrlForAppointment(appointment.id, appointment.rescheduleToken);
      const body = `No problem. Use this link to reschedule: ${rescheduleUrl}`;

      const state =
        input.leadId && replyChannel
          ? await getLeadAutomationState(input.db, input.leadId, replyChannel)
          : null;
      if (!state?.paused && !state?.dnc && !state?.humanTakeover) {
        await queueThreadMessage({
          db: input.db,
          threadId: input.threadId,
          channel: replyChannel,
          toAddress,
          body,
          metadata: {
            confirmationLoop: true,
            confirmationIntent: "decline",
            appointmentId: appointment.id
          },
          createdAt: now
        });
      }
    }

    await recordAuditEvent({
      actor: { type: "ai", label: "confirmation-loop" },
      action: "appointment.reschedule_requested",
      entityType: "appointment",
      entityId: appointment.id,
      meta: { messageId: input.messageId, channel }
    });

    return true;
  }

  return false;
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

  const confirmationHandled = await handleConfirmationReply({
    db,
    messageId: row.messageId,
    threadId,
    leadId: row.leadId ?? null,
    contactId: row.contactId ?? null,
    channel: row.channel ?? "sms",
    body: row.body ?? "",
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    contactPhoneE164: row.contactPhoneE164 ?? null
  });
  if (confirmationHandled) {
    return { status: "processed" };
  }

  const inboundChannel = row.channel ?? "sms";
  const candidates = resolveCandidateChannels(inboundChannel);
  if (candidates.length === 0) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: { reason: "unsupported_channel", inboundChannel }
    });
    return { status: "skipped" };
  }
  const attempted: Array<{ channel: AutoReplyChannel; reason: string }> = [];
  let selectedChannel: AutoReplyChannel | null = null;
  let selectedMode: AutomationMode | null = null;

  for (const channel of candidates) {
    const mode = await getAutomationMode(db, channel);
    if (mode === "draft") {
      attempted.push({ channel, reason: "mode_draft" });
      continue;
    }

    if (row.leadId) {
      const state = await getLeadAutomationState(db, row.leadId, channel);
      if (state?.paused || state?.dnc || state?.humanTakeover) {
        attempted.push({ channel, reason: "lead_kill_switch" });
        continue;
      }
    }

    const toAddress =
      channel === "sms"
        ? row.contactPhoneE164 ?? row.contactPhone ?? null
        : row.contactEmail ?? null;
    if (!toAddress) {
      attempted.push({ channel, reason: "missing_recipient" });
      continue;
    }

    selectedChannel = channel;
    selectedMode = mode;
    break;
  }

  if (!selectedChannel) {
    await recordAuditEvent({
      actor: { type: "ai", label: "auto-reply" },
      action: "auto_reply.skipped",
      entityType: "conversation_message",
      entityId: row.messageId,
      meta: {
        reason: "no_eligible_channel",
        inboundChannel,
        attempted
      }
    });
    return { status: "skipped" };
  }

  const replyChannel = selectedChannel;
  const toAddress =
    replyChannel === "sms"
      ? row.contactPhoneE164 ?? row.contactPhone ?? null
      : row.contactEmail ?? null;

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
          replyChannel,
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
      mode: selectedMode,
      delayMs
    }
  });

  return { status: "processed" };
}
