import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmTasks,
  getDb
} from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { generateOutboundFirstTouchDraft } from "@/lib/outbound-drafts";

const CHANNELS = ["sms", "email"] as const;
type Channel = (typeof CHANNELS)[number];

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

function parseOutboundNoteField(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "i"));
  const value = match?.[1]?.trim();
  return value && value.length ? value : null;
}

async function ensureThreadForContact(
  db: ReturnType<typeof getDb>,
  input: { contactId: string; channel: Channel; assignedTo: string | null }
): Promise<string> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, input.contactId),
        eq(conversationThreads.channel, input.channel),
        or(eq(conversationThreads.status, "open"), eq(conversationThreads.status, "pending"), eq(conversationThreads.status, "closed"))
      )
    )
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(1);

  if (existing?.id) return existing.id;

  const now = new Date();
  const [thread] = await db
    .insert(conversationThreads)
    .values({
      contactId: input.contactId,
      channel: input.channel,
      status: "open",
      state: "new",
      assignedTo: input.assignedTo,
      stateUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: conversationThreads.id });

  if (!thread?.id) {
    throw new Error("thread_create_failed");
  }

  const [contact] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  const displayName = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || "Contact";
  const externalAddress =
    input.channel === "email"
      ? contact?.email ?? null
      : contact?.phoneE164 ?? contact?.phone ?? null;

  await db.insert(conversationParticipants).values({
    threadId: thread.id,
    participantType: "contact",
    contactId: input.contactId,
    externalAddress,
    displayName,
    createdAt: now
  });

  return thread.id;
}

async function ensureAgentParticipant(
  db: ReturnType<typeof getDb>,
  input: { threadId: string; displayName: string }
): Promise<string> {
  const [existing] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, input.threadId),
        eq(conversationParticipants.participantType, "team"),
        eq(conversationParticipants.displayName, input.displayName),
        sql`${conversationParticipants.teamMemberId} is null`
      )
    )
    .limit(1);

  if (existing?.id) return existing.id;

  const now = new Date();
  const [created] = await db
    .insert(conversationParticipants)
    .values({
      threadId: input.threadId,
      participantType: "team",
      teamMemberId: null,
      displayName: input.displayName,
      createdAt: now
    })
    .returning({ id: conversationParticipants.id });

  if (!created?.id) throw new Error("participant_create_failed");
  return created.id;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const contactId = readString((payload as any).contactId) ?? "";
  const taskId = readString((payload as any).taskId);
  const channelRaw = readString((payload as any).channel);
  const requestedChannel: Channel | null = isChannel(channelRaw) ? (channelRaw as Channel) : null;

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date();

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact?.id) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const hasEmail = Boolean(contact.email && contact.email.trim().length);
  const channel: Channel = requestedChannel ?? (hasEmail ? "email" : "sms");

  const toAddress =
    channel === "email"
      ? (contact.email ?? "").trim()
      : (contact.phoneE164 ?? contact.phone ?? "").trim();

  if (!toAddress) {
    return NextResponse.json(
      { error: channel === "email" ? "contact_missing_email" : "contact_missing_phone" },
      { status: 400 }
    );
  }

  let campaign: string | null = null;
  let attempt = 1;
  let companyFromTask: string | null = null;
  let notesFromTask: string | null = null;

  if (taskId) {
    const [task] = await db
      .select({ id: crmTasks.id, notes: crmTasks.notes })
      .from(crmTasks)
      .where(and(eq(crmTasks.id, taskId), eq(crmTasks.contactId, contactId)))
      .limit(1);
    const notes = typeof task?.notes === "string" ? task.notes : "";
    if (notes.toLowerCase().includes("kind=outbound")) {
      campaign = parseOutboundNoteField(notes, "campaign");
      const attemptRaw = Number(parseOutboundNoteField(notes, "attempt") ?? "1");
      if (Number.isFinite(attemptRaw) && attemptRaw > 0) attempt = Math.floor(attemptRaw);
      companyFromTask = parseOutboundNoteField(notes, "company");
      notesFromTask = parseOutboundNoteField(notes, "notes");
    }
  }

  const recipientName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || null;
  const company = companyFromTask ?? contact.company ?? null;

  const threadId = await ensureThreadForContact(db, {
    contactId,
    channel,
    assignedTo: contact.salespersonMemberId ?? null
  });

  const autopilot = await getSalesAutopilotPolicy(db);
  const agentParticipantId = await ensureAgentParticipant(db, {
    threadId,
    displayName: autopilot.agentDisplayName
  });

  const draft = await generateOutboundFirstTouchDraft({
    channel,
    recipientName,
    company,
    campaign,
    attempt,
    notes: notesFromTask
  });

  const subject = channel === "email" ? draft.subject : null;
  const body = draft.body;

  const [message] = await db
    .insert(conversationMessages)
    .values({
      threadId,
      participantId: agentParticipantId,
      direction: "outbound",
      channel,
      subject,
      body,
      toAddress,
      deliveryStatus: "queued",
      metadata: {
        draft: true,
        automation: true,
        outbound: true,
        outboundKind: "first_touch",
        outboundCampaign: campaign ?? undefined,
        outboundAttempt: attempt,
        outboundTaskId: taskId ?? undefined,
        generatedBy: draft.provider,
        generatedModel: draft.model ?? undefined
      },
      createdAt: now
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) {
    return NextResponse.json({ error: "draft_create_failed" }, { status: 500 });
  }

  await db
    .update(conversationThreads)
    .set({
      lastMessagePreview: body.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now
    })
    .where(eq(conversationThreads.id, threadId));

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "outbound.draft_created",
    entityType: "conversation_message",
    entityId: message.id,
    meta: {
      contactId,
      threadId,
      channel,
      toAddress,
      campaign,
      attempt,
      taskId: taskId ?? null
    }
  });

  return NextResponse.json({
    ok: true,
    contactId,
    threadId,
    messageId: message.id,
    channel
  });
}

