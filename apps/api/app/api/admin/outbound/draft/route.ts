import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmTasks,
  getDb,
  partnerAccounts,
} from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import {
  generateOutboundFirstTouchDraft,
  generateOutboundFollowupDraft,
  type OutboundDraftContextMessage,
} from "@/lib/outbound-drafts";
import {
  GENERIC_INBOX_STAFF_SCOPE,
  genericInboxThreadScopeCondition,
} from "@/lib/inbox-staff-scope";

const CHANNELS = ["sms", "email"] as const;
type Channel = (typeof CHANNELS)[number];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  input: { contactId: string; channel: Channel; assignedTo: string | null },
): Promise<string> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, input.contactId),
        eq(conversationThreads.channel, input.channel),
        genericInboxThreadScopeCondition(),
        or(
          eq(conversationThreads.status, "open"),
          eq(conversationThreads.status, "pending"),
          eq(conversationThreads.status, "closed"),
        ),
      ),
    )
    .orderBy(
      desc(conversationThreads.lastMessageAt),
      desc(conversationThreads.updatedAt),
    )
    .limit(1);

  if (existing?.id) return existing.id;

  const now = new Date();
  const [thread] = await db
    .insert(conversationThreads)
    .values({
      contactId: input.contactId,
      channel: input.channel,
      staffScope: GENERIC_INBOX_STAFF_SCOPE,
      status: "open",
      state: "new",
      assignedTo: input.assignedTo,
      stateUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
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
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  const displayName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() ||
    "Contact";
  const externalAddress =
    input.channel === "email"
      ? (contact?.email ?? null)
      : (contact?.phoneE164 ?? contact?.phone ?? null);

  await db.insert(conversationParticipants).values({
    threadId: thread.id,
    participantType: "contact",
    contactId: input.contactId,
    externalAddress,
    displayName,
    createdAt: now,
  });

  return thread.id;
}

async function ensureAgentParticipant(
  db: ReturnType<typeof getDb>,
  input: { threadId: string; displayName: string },
): Promise<string> {
  const [existing] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, input.threadId),
        eq(conversationParticipants.participantType, "team"),
        eq(conversationParticipants.displayName, input.displayName),
        sql`${conversationParticipants.teamMemberId} is null`,
      ),
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
      createdAt: now,
    })
    .returning({ id: conversationParticipants.id });

  if (!created?.id) throw new Error("participant_create_failed");
  return created.id;
}

async function loadRecentContactHistory(
  db: ReturnType<typeof getDb>,
  contactId: string,
): Promise<OutboundDraftContextMessage[]> {
  const rows = await db
    .select({
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      subject: conversationMessages.subject,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        genericInboxThreadScopeCondition(),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(12);

  return rows
    .reverse()
    .map((row) => ({
      direction: row.direction,
      channel: row.channel,
      subject: row.subject,
      body: row.body,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date().toISOString(),
    }))
    .filter((message) => message.body.trim().length > 0);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "outbound.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const payloadRecord = payload as Record<string, unknown>;

  const contactId = readString(payloadRecord["contactId"]) ?? "";
  const taskId = readString(payloadRecord["taskId"]);
  const channelRaw = readString(payloadRecord["channel"]);
  const kindRaw = readString(payloadRecord["kind"]);
  const recap = readString(payloadRecord["recap"]);
  const explicitDisposition = readString(payloadRecord["disposition"]);
  const requestedChannel: Channel | null = isChannel(channelRaw)
    ? channelRaw
    : null;
  const kind = kindRaw === "follow_up" ? "follow_up" : "first_touch";

  if (
    !UUID_PATTERN.test(contactId) ||
    (payloadRecord["taskId"] !== undefined &&
      (!taskId || !UUID_PATTERN.test(taskId))) ||
    (payloadRecord["channel"] !== undefined && !requestedChannel) ||
    (payloadRecord["kind"] !== undefined &&
      kindRaw !== "first_touch" &&
      kindRaw !== "follow_up") ||
    (recap?.length ?? 0) > 4_000 ||
    (explicitDisposition?.length ?? 0) > 80
  ) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "Check the selected contact, task, and draft details before trying again.",
      },
      { status: 400 },
    );
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
      salespersonMemberId: contacts.salespersonMemberId,
      partnerAccountId: contacts.partnerAccountId,
      doNotContact: contacts.doNotContact,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact?.id || contact.deletedAt) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }
  if (contact.doNotContact) {
    return NextResponse.json(
      {
        error: "contact_outreach_blocked",
        message:
          "This contact is marked Do Not Contact. No outreach draft was created.",
      },
      { status: 409 },
    );
  }

  // Validate an explicit task before creating a thread, draft, or other record.
  // Never infer a task binding from the company name or another contact.
  let taskNotes = "";
  let taskAccountId: string | null = null;
  if (taskId) {
    const [task] = await db
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        partnerAccountId: crmTasks.partnerAccountId,
        notes: crmTasks.notes,
      })
      .from(crmTasks)
      .where(and(eq(crmTasks.id, taskId), eq(crmTasks.contactId, contactId)))
      .limit(1);
    if (
      !task ||
      task.contactId !== contactId ||
      !/(?:^|\n)kind=outbound(?:\n|$)/iu.test(task.notes ?? "") ||
      (task.partnerAccountId !== null &&
        contact.partnerAccountId !== null &&
        task.partnerAccountId !== contact.partnerAccountId)
    ) {
      return NextResponse.json(
        {
          error: "outbound_task_not_found",
          message:
            "The selected outbound task is no longer available for this contact. Refresh the queue.",
        },
        { status: 404 },
      );
    }
    taskNotes = task.notes ?? "";
    taskAccountId = task.partnerAccountId;
  }

  const partnerAccountId = contact.partnerAccountId ?? taskAccountId;
  let accountName: string | null = null;
  let accountSegment: string | null = null;
  let accountCity: string | null = null;
  let accountState: string | null = null;

  if (partnerAccountId) {
    const [account] = await db
      .select({
        id: partnerAccounts.id,
        name: partnerAccounts.name,
        segment: partnerAccounts.segment,
        city: partnerAccounts.city,
        state: partnerAccounts.state,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, partnerAccountId))
      .limit(1);

    accountName = account?.name ?? null;
    accountSegment = account?.segment ?? null;
    accountCity = account?.city ?? null;
    accountState = account?.state ?? null;
  }

  const hasEmail = Boolean(contact.email && contact.email.trim().length);
  const channel: Channel = requestedChannel ?? (hasEmail ? "email" : "sms");

  const toAddress =
    channel === "email"
      ? (contact.email ?? "").trim()
      : (contact.phoneE164 ?? contact.phone ?? "").trim();

  if (!toAddress) {
    return NextResponse.json(
      {
        error:
          channel === "email"
            ? "contact_missing_email"
            : "contact_missing_phone",
      },
      { status: 400 },
    );
  }

  let campaign: string | null = null;
  let attempt = 1;
  let companyFromTask: string | null = null;
  let notesFromTask: string | null = null;
  let lastDisposition: string | null = explicitDisposition;

  if (taskId) {
    const notes = taskNotes;
    if (notes.toLowerCase().includes("kind=outbound")) {
      campaign = parseOutboundNoteField(notes, "campaign");
      const attemptRaw = Number(
        parseOutboundNoteField(notes, "attempt") ?? "1",
      );
      if (Number.isFinite(attemptRaw) && attemptRaw > 0)
        attempt = Math.floor(attemptRaw);
      companyFromTask = parseOutboundNoteField(notes, "company");
      notesFromTask = parseOutboundNoteField(notes, "notes");
      lastDisposition =
        lastDisposition ?? parseOutboundNoteField(notes, "lastDisposition");
    }
  }

  const recipientName =
    `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || null;
  const company = accountName ?? companyFromTask ?? contact.company ?? null;

  const threadId = await ensureThreadForContact(db, {
    contactId,
    channel,
    assignedTo: contact.salespersonMemberId ?? null,
  });

  const autopilot = await getSalesAutopilotPolicy(db);
  const agentParticipantId = await ensureAgentParticipant(db, {
    threadId,
    displayName: autopilot.agentDisplayName,
  });
  const recentMessages = await loadRecentContactHistory(db, contactId);

  const draft =
    kind === "follow_up"
      ? await generateOutboundFollowupDraft({
          channel,
          recipientName,
          company,
          campaign,
          attempt,
          notes: notesFromTask,
          segment: accountSegment,
          city: accountCity,
          state: accountState,
          disposition: lastDisposition,
          recap,
          recentMessages,
        })
      : await generateOutboundFirstTouchDraft({
          channel,
          recipientName,
          company,
          campaign,
          attempt,
          notes: notesFromTask,
          segment: accountSegment,
          city: accountCity,
          state: accountState,
          recentMessages,
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
        outboundKind: kind,
        outboundCampaign: campaign ?? undefined,
        outboundAttempt: attempt,
        outboundDisposition: lastDisposition ?? undefined,
        outboundRecap: recap ?? undefined,
        outboundTaskId: taskId ?? undefined,
        partnerAccountId: partnerAccountId ?? undefined,
        generatedBy: draft.provider,
        generatedModel: draft.model ?? undefined,
      },
      createdAt: now,
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
      updatedAt: now,
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
      kind,
      disposition: lastDisposition ?? null,
      campaign,
      attempt,
      taskId: taskId ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    contactId,
    threadId,
    messageId: message.id,
    channel,
  });
}
