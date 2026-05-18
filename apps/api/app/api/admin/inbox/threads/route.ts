import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  properties,
  teamMembers,
  leadAutomationStates,
  leads,
  outboxEvents
} from "@/db";
import { isConversationState, type ConversationState } from "@/lib/conversation-state";
import { getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const THREAD_STATUS = ["open", "pending", "closed"] as const;
const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ThreadStatus = (typeof THREAD_STATUS)[number];
type Channel = (typeof CHANNELS)[number];
type ThreadState = ConversationState;
type InboxView = "attention" | "google" | "all";
type SourceFamily = "Google" | "Facebook" | "Website" | "Missed Call" | "Partner" | "Other";

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeSearch(term: string): string {
  return term.replace(/[%_]/g, "\\$&").replace(/\s+/g, " ").trim();
}

function isStatus(value: string | null): value is ThreadStatus {
  return value ? (THREAD_STATUS as readonly string[]).includes(value) : false;
}

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

function parseView(value: string | null): InboxView {
  return value === "attention" || value === "google" || value === "all" ? value : "all";
}

function classifySourceFamily(input: {
  leadSource?: string | null;
  leadUtmSource?: string | null;
  leadGclid?: string | null;
  leadFbclid?: string | null;
  contactSource?: string | null;
  channel?: string | null;
}): SourceFamily {
  const values = [
    input.leadSource,
    input.leadUtmSource,
    input.contactSource,
    input.leadGclid ? "google" : null,
    input.leadFbclid ? "facebook" : null,
    input.channel === "dm" ? "facebook" : null,
    input.channel === "call" ? "missed_call" : null
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (values.includes("google") || values.includes("gclid")) return "Google";
  if (values.includes("facebook") || values.includes("fbclid") || values.includes("meta")) return "Facebook";
  if (values.includes("missed_call") || values.includes("missed call") || values.includes("inbound_call")) return "Missed Call";
  if (values.includes("partner")) return "Partner";
  if (values.includes("website") || values.includes("public_site") || values.includes("instant_quote") || values.includes("web")) {
    return "Website";
  }
  return "Other";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const rawSearch = searchParams.get("q");
  const searchTerm = rawSearch ? normalizeSearch(rawSearch) : null;
  const status = isStatus(searchParams.get("status")) ? (searchParams.get("status") as ThreadStatus) : null;
  const channel = isChannel(searchParams.get("channel")) ? (searchParams.get("channel") as Channel) : null;
  const contactId = searchParams.get("contactId");
  const view = parseView(searchParams.get("view"));
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const lastInboundForThread = sql<Date | null>`(
    select max(coalesce(cm.received_at, cm.created_at))
    from conversation_messages cm
    where cm.thread_id = ${conversationThreads.id}
      and cm.direction = 'inbound'
      and coalesce(cm.metadata ->> 'draft', 'false') <> 'true'
  )`;
  const lastOutboundForThread = sql<Date | null>`(
    select max(coalesce(cm.sent_at, cm.created_at))
    from conversation_messages cm
    where cm.thread_id = ${conversationThreads.id}
      and cm.direction = 'outbound'
      and coalesce(cm.metadata ->> 'draft', 'false') <> 'true'
  )`;
  const lastDirectionForThread = sql<string | null>`(
    select cm.direction::text
    from conversation_messages cm
    where cm.thread_id = ${conversationThreads.id}
      and coalesce(cm.metadata ->> 'draft', 'false') <> 'true'
    order by coalesce(cm.received_at, cm.sent_at, cm.created_at) desc
    limit 1
  )`;
  const mediaCountForThread = sql<number>`(
    select coalesce(sum(cardinality(coalesce(cm.media_urls, array[]::text[]))), 0)
    from conversation_messages cm
    where cm.thread_id = ${conversationThreads.id}
  )`;
  const googleSourceFilter = sql`(
    coalesce(${leads.gclid}, '') <> ''
    or lower(coalesce(${leads.source}, '')) like '%google%'
    or lower(coalesce(${leads.utmSource}, '')) like '%google%'
    or lower(coalesce(${contacts.source}, '')) like '%google%'
  )`;
  const facebookSourceFilter = sql`(
    coalesce(${leads.fbclid}, '') <> ''
    or lower(coalesce(${leads.source}, '')) like '%facebook%'
    or lower(coalesce(${leads.source}, '')) like '%meta%'
    or lower(coalesce(${leads.utmSource}, '')) like '%facebook%'
    or lower(coalesce(${leads.utmSource}, '')) like '%meta%'
    or lower(coalesce(${contacts.source}, '')) like '%facebook%'
    or lower(coalesce(${contacts.source}, '')) like '%meta%'
    or ${conversationThreads.channel} = 'dm'
  )`;
  const activeThreadFilter = sql`${conversationThreads.status} <> 'closed' and coalesce(${contacts.doNotContact}, false) = false`;
  const dueFollowupFilter = sql`(
    ${leadAutomationStates.nextFollowupAt} is not null
    and ${leadAutomationStates.nextFollowupAt} <= ${nowIso}::timestamptz
    and coalesce(${leadAutomationStates.paused}, false) = false
    and coalesce(${leadAutomationStates.dnc}, false) = false
  )`;
  const inboundNeedsReplyFilter = sql`(
    ${lastInboundForThread} is not null
    and ${lastInboundForThread} > coalesce(
      greatest(${lastOutboundForThread}, ${conversationThreads.attentionHandledAt}),
      '-infinity'::timestamptz
    )
  )`;
  const newUnrepliedLeadFilter = sql`(
    ${conversationThreads.leadId} is not null
    and ${lastOutboundForThread} is null
    and ${conversationThreads.attentionHandledAt} is null
  )`;
  const attentionFilter = sql`(${activeThreadFilter} and (${inboundNeedsReplyFilter} or ${newUnrepliedLeadFilter} or ${dueFollowupFilter}))`;
  const priorityScoreSql = sql<number>`case
    when coalesce(${contacts.doNotContact}, false) then -100
    when ${conversationThreads.status} = 'closed' then -80
    when ${dueFollowupFilter} then 120
    when ${googleSourceFilter} and (${inboundNeedsReplyFilter} or ${newUnrepliedLeadFilter}) then 110
    when ${inboundNeedsReplyFilter} then 95
    when ${googleSourceFilter} then 70
    when ${mediaCountForThread} > 0 then 35
    when ${facebookSourceFilter} then 15
    else 25
  end`;

  const filters = [];

  if (status) {
    filters.push(eq(conversationThreads.status, status));
  }
  if (channel) {
    filters.push(eq(conversationThreads.channel, channel));
  }
  if (searchTerm) {
    const likePattern = `%${searchTerm.replace(/\s+/g, "%")}%`;
    filters.push(
      or(
        ilike(contacts.firstName, likePattern),
        ilike(contacts.lastName, likePattern),
        ilike(contacts.email, likePattern),
        ilike(contacts.phone, likePattern),
        ilike(contacts.source, likePattern),
        ilike(leads.source, likePattern),
        ilike(leads.utmSource, likePattern),
        ilike(conversationThreads.subject, likePattern),
        ilike(conversationThreads.lastMessagePreview, likePattern)
      )
    );
  }
  if (typeof contactId === "string" && UUID_RE.test(contactId)) {
    filters.push(eq(conversationThreads.contactId, contactId));
  }
  if (view === "attention" && !searchTerm) {
    filters.push(attentionFilter);
  }
  if (view === "google" && !searchTerm) {
    filters.push(sql`${activeThreadFilter} and ${googleSourceFilter}`);
  }

  const whereClause = filters.length ? and(...filters) : undefined;
  const inboundLatest = db
    .select({
      threadId: conversationMessages.threadId,
      lastInboundAt: sql<Date | null>`max(coalesce(${conversationMessages.receivedAt}, ${conversationMessages.createdAt}))`.as(
        "lastInboundAt"
      )
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.direction, "inbound"))
    .groupBy(conversationMessages.threadId)
    .as("inboundLatest");

  const outboundLatest = db
    .select({
      threadId: conversationMessages.threadId,
      lastOutboundAt: sql<Date | null>`max(coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt}))`.as(
        "lastOutboundAt"
      )
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.direction, "outbound"))
    .groupBy(conversationMessages.threadId)
    .as("outboundLatest");

  const activityLatest = db
    .select({
      threadId: conversationMessages.threadId,
      lastActivityAt:
        sql<Date | null>`max(coalesce(${conversationMessages.receivedAt}, ${conversationMessages.sentAt}, ${conversationMessages.createdAt}))`.as(
          "lastActivityAt"
        )
    })
    .from(conversationMessages)
    .where(sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`)
    .groupBy(conversationMessages.threadId)
    .as("activityLatest");

  const totalQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(conversationThreads)
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(leads, eq(conversationThreads.leadId, leads.id))
    .leftJoin(
      leadAutomationStates,
      and(
        eq(leadAutomationStates.leadId, conversationThreads.leadId),
        sql`${leadAutomationStates.channel}::text = ${conversationThreads.channel}::text`
      )
    );
  const totalResult = whereClause ? await totalQuery.where(whereClause) : await totalQuery;
  const total = Number(totalResult[0]?.count ?? 0);

  const rowsQuery = db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
      state: conversationThreads.state,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      lastActivityAt: activityLatest.lastActivityAt,
      resolvedLastMessagePreview: sql<string | null>`coalesce(
        ${conversationThreads.lastMessagePreview},
        (
          select coalesce(cm.body, 'Media message')
          from conversation_messages cm
          where cm.thread_id = ${conversationThreads.id}
          order by coalesce(cm.received_at, cm.sent_at, cm.created_at) desc
          limit 1
        )
      )`,
      updatedAt: conversationThreads.updatedAt,
      stateUpdatedAt: conversationThreads.stateUpdatedAt,
      attentionHandledAt: conversationThreads.attentionHandledAt,
      closedReason: conversationThreads.closedReason,
      closedAt: conversationThreads.closedAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
      propertyId: conversationThreads.propertyId,
      assignedTo: conversationThreads.assignedTo,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      contactSource: contacts.source,
      doNotContact: contacts.doNotContact,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      assignedName: teamMembers.name,
      leadSource: leads.source,
      leadUtmSource: leads.utmSource,
      leadGclid: leads.gclid,
      leadFbclid: leads.fbclid,
      followupState: leadAutomationStates.followupState,
      followupStep: leadAutomationStates.followupStep,
      nextFollowupAt: leadAutomationStates.nextFollowupAt,
      followupPaused: leadAutomationStates.paused,
      followupDnc: leadAutomationStates.dnc,
      lastInboundAt: inboundLatest.lastInboundAt,
      lastOutboundAt: outboundLatest.lastOutboundAt,
      lastDirection: lastDirectionForThread,
      mediaCount: mediaCountForThread,
      priorityScore: priorityScoreSql
    })
    .from(conversationThreads)
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(leads, eq(conversationThreads.leadId, leads.id))
    .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
    .leftJoin(
      leadAutomationStates,
      and(
        eq(leadAutomationStates.leadId, conversationThreads.leadId),
        sql`${leadAutomationStates.channel}::text = ${conversationThreads.channel}::text`
      )
    )
    .leftJoin(teamMembers, eq(conversationThreads.assignedTo, teamMembers.id))
    .leftJoin(inboundLatest, eq(inboundLatest.threadId, conversationThreads.id))
    .leftJoin(outboundLatest, eq(outboundLatest.threadId, conversationThreads.id))
    .leftJoin(activityLatest, eq(activityLatest.threadId, conversationThreads.id));

  const rows = await (whereClause ? rowsQuery.where(whereClause) : rowsQuery)
    .orderBy(sql`${priorityScoreSql} desc`, sql`${activityLatest.lastActivityAt} desc nulls last`, desc(conversationThreads.updatedAt))
    .limit(limit)
    .offset(offset);

  const serviceArea = await getServiceAreaPolicy(db);

  const threadIds = rows.map((row) => row.id);
  const messageCounts =
    threadIds.length > 0
      ? await db
          .select({
            threadId: conversationMessages.threadId,
            count: sql<number>`count(*)`
          })
          .from(conversationMessages)
          .where(inArray(conversationMessages.threadId, threadIds))
          .groupBy(conversationMessages.threadId)
      : [];

  const messageCountMap = new Map<string, number>();
  for (const row of messageCounts) {
    messageCountMap.set(row.threadId, Number(row.count));
  }

  const normalizeIsoTimestamp = (value: unknown): string | null => {
    if (value instanceof Date) return value.toISOString();
    if (value && typeof (value as { toISOString?: unknown }).toISOString === "function") {
      try {
        return (value as { toISOString: () => string }).toISOString();
      } catch {
        // ignore
      }
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
    }
    return null;
  };

  const threads = rows.map((row) => {
    const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim();
    const normalizedPostalCode = normalizePostalCode(row.propertyPostalCode ?? null);
    const outOfArea =
      normalizedPostalCode !== null ? !isPostalCodeAllowed(normalizedPostalCode, serviceArea) : null;
    const lastActivityIso = normalizeIsoTimestamp(row.lastActivityAt as unknown);
    const lastInboundIso = normalizeIsoTimestamp(row.lastInboundAt as unknown);
    const lastOutboundIso = normalizeIsoTimestamp(row.lastOutboundAt as unknown);
    const updatedAtIso = normalizeIsoTimestamp(row.updatedAt as unknown);
    const stateUpdatedAtIso = normalizeIsoTimestamp(row.stateUpdatedAt as unknown);
    const attentionHandledIso = normalizeIsoTimestamp(row.attentionHandledAt as unknown);
    const closedAtIso = normalizeIsoTimestamp(row.closedAt as unknown);
    const nextFollowupIso = normalizeIsoTimestamp(row.nextFollowupAt as unknown);
    const sourceFamily = classifySourceFamily({
      leadSource: row.leadSource,
      leadUtmSource: row.leadUtmSource,
      leadGclid: row.leadGclid,
      leadFbclid: row.leadFbclid,
      contactSource: row.contactSource,
      channel: row.channel
    });
    const lastInboundMs = lastInboundIso ? Date.parse(lastInboundIso) : NaN;
    const lastOutboundMs = lastOutboundIso ? Date.parse(lastOutboundIso) : NaN;
    const handledMs = attentionHandledIso ? Date.parse(attentionHandledIso) : NaN;
    const nextFollowupMs = nextFollowupIso ? Date.parse(nextFollowupIso) : NaN;
    const doNotContact = row.doNotContact === true;
    const isClosed = row.status === "closed";
    const followupDue =
      Number.isFinite(nextFollowupMs) &&
      nextFollowupMs <= now.getTime() &&
      row.followupPaused !== true &&
      row.followupDnc !== true;
    const needsReply =
      Number.isFinite(lastInboundMs) &&
      lastInboundMs > Math.max(Number.isFinite(lastOutboundMs) ? lastOutboundMs : -Infinity, Number.isFinite(handledMs) ? handledMs : -Infinity);
    const newUnrepliedLead = Boolean(row.leadId) && !Number.isFinite(lastOutboundMs) && !Number.isFinite(handledMs);
    const needsAttention = !isClosed && !doNotContact && (followupDue || needsReply || newUnrepliedLead);
    const attentionReason = doNotContact
      ? "dnc"
      : isClosed
        ? row.closedReason ?? "closed"
        : followupDue
          ? "follow_up_due"
          : needsReply
            ? "needs_reply"
            : newUnrepliedLead
              ? "new_lead"
              : row.lastDirection === "outbound"
                ? "waiting"
                : null;
    const waitingSince = followupDue ? nextFollowupIso : needsReply || newUnrepliedLead ? lastInboundIso ?? updatedAtIso : null;
    return {
      id: row.id,
      status: row.status,
      state: row.state,
      channel: row.channel,
      subject: row.subject ?? null,
      sourceFamily,
      lastMessagePreview: row.resolvedLastMessagePreview ?? null,
      lastMessageAt: lastActivityIso,
      updatedAt: updatedAtIso,
      stateUpdatedAt: stateUpdatedAtIso,
      lastInboundAt: lastInboundIso,
      lastOutboundAt: lastOutboundIso,
      attentionHandledAt: attentionHandledIso,
      waitingSince,
      attentionReason,
      needsAttention,
      priorityScore: Number(row.priorityScore ?? 0),
      closedReason: row.closedReason ?? null,
      closedAt: closedAtIso,
      doNotContact,
      mediaCount: Number(row.mediaCount ?? 0),
      contact: row.contactId
        ? {
            id: row.contactId,
            name: contactName || "Contact",
            email: row.contactEmail ?? null,
            phone: row.contactPhoneE164 ?? row.contactPhone ?? null
          }
        : null,
      property: row.propertyId
        ? {
            id: row.propertyId,
            addressLine1: row.propertyAddressLine1 ?? "",
            city: row.propertyCity ?? "",
            state: row.propertyState ?? "",
            postalCode: row.propertyPostalCode ?? "",
            outOfArea
          }
        : null,
      leadId: row.leadId ?? null,
      assignedTo: row.assignedTo
        ? {
            id: row.assignedTo,
            name: row.assignedName ?? "Assigned"
          }
        : null,
      messageCount: messageCountMap.get(row.id) ?? 0,
      followup: row.leadId
        ? {
            state: row.followupState ?? null,
            step: typeof row.followupStep === "number" ? row.followupStep : null,
            nextAt: nextFollowupIso
          }
        : null
    };
  });

  const nextOffset = offset + threads.length;

  return NextResponse.json({
    threads,
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null
    }
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    contactId?: string;
    leadId?: string;
    propertyId?: string;
    status?: string;
    state?: string;
    channel?: string;
    subject?: string;
    message?: string;
    direction?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const status = isStatus(payload.status ?? null) ? (payload.status as ThreadStatus) : "open";
  const channel = isChannel(payload.channel ?? null) ? (payload.channel as Channel) : "sms";
  if (payload.state && !isConversationState(payload.state)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const state = isConversationState(payload.state ?? null) ? (payload.state as ThreadState) : "new";

  let contactId = typeof payload.contactId === "string" ? payload.contactId.trim() : "";
  const leadId = typeof payload.leadId === "string" ? payload.leadId.trim() : "";
  let propertyId = typeof payload.propertyId === "string" ? payload.propertyId.trim() : "";

  if (!contactId && !leadId) {
    return NextResponse.json({ error: "contact_or_lead_required" }, { status: 400 });
  }

  const subject = typeof payload.subject === "string" && payload.subject.trim().length > 0 ? payload.subject.trim() : null;
  const messageBody = typeof payload.message === "string" ? payload.message.trim() : "";
  const direction =
    payload.direction === "inbound" || payload.direction === "internal" ? payload.direction : "outbound";

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  let result: {
    thread: typeof conversationThreads.$inferSelect;
    message: typeof conversationMessages.$inferSelect | null;
  };
  try {
    result = await db.transaction(async (tx) => {
      let contactRecord =
        contactId.length > 0
          ? await tx
              .select({
                id: contacts.id,
                firstName: contacts.firstName,
                lastName: contacts.lastName,
                email: contacts.email,
                phone: contacts.phone,
                phoneE164: contacts.phoneE164
              })
              .from(contacts)
              .where(eq(contacts.id, contactId))
              .limit(1)
              .then((rows) => rows[0])
          : undefined;

      if (!contactRecord && leadId) {
        const [leadRow] = await tx
          .select({
            contactId: leads.contactId,
            propertyId: leads.propertyId
          })
          .from(leads)
          .where(eq(leads.id, leadId))
          .limit(1);
        if (leadRow?.contactId) {
          contactId = leadRow.contactId;
          propertyId = propertyId || leadRow.propertyId || "";
          contactRecord = await tx
            .select({
              id: contacts.id,
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              email: contacts.email,
              phone: contacts.phone,
              phoneE164: contacts.phoneE164
            })
            .from(contacts)
            .where(eq(contacts.id, leadRow.contactId))
            .limit(1)
            .then((rows) => rows[0]);
        }
      }

      if (!contactId) {
        throw new Error("contact_not_found");
      }

      const now = new Date();
      const [thread] = await tx
        .insert(conversationThreads)
        .values({
          leadId: leadId || null,
          contactId,
          propertyId: propertyId || null,
          status,
          state,
          channel,
          subject,
          stateUpdatedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      if (!thread) {
        throw new Error("thread_create_failed");
      }

      let contactParticipantId: string | null = null;
      if (contactRecord?.id) {
        const displayName = [contactRecord.firstName, contactRecord.lastName].filter(Boolean).join(" ").trim();
        const externalAddress =
          channel === "email"
            ? contactRecord.email
            : contactRecord.phoneE164 ?? contactRecord.phone ?? null;

        const [participant] = await tx
          .insert(conversationParticipants)
          .values({
            threadId: thread.id,
            participantType: "contact",
            contactId: contactRecord.id,
            externalAddress,
            displayName: displayName || "Contact",
            createdAt: new Date()
          })
          .returning();

        contactParticipantId = participant?.id ?? null;
      }

      let messageRecord: typeof conversationMessages.$inferSelect | null = null;

      if (messageBody.length > 0) {
        let participantId = contactParticipantId;
        if (direction !== "inbound") {
          const [teamParticipant] = await tx
            .insert(conversationParticipants)
            .values({
              threadId: thread.id,
              participantType: "team",
              teamMemberId: actor.id ?? null,
              displayName: actor.label ?? "Team Console",
              createdAt: new Date()
            })
            .returning();
          participantId = teamParticipant?.id ?? null;
        }

        const now = new Date();
        const deliveryStatus =
          direction === "inbound" ? "delivered" : direction === "internal" ? "sent" : "queued";

        const [message] = await tx
          .insert(conversationMessages)
          .values({
            threadId: thread.id,
            participantId,
            direction,
            channel,
            subject,
            body: messageBody,
            deliveryStatus,
            sentAt: deliveryStatus === "sent" ? now : null,
            receivedAt: direction === "inbound" ? now : null,
            createdAt: now
          })
          .returning();

        messageRecord = message ?? null;

        await tx
          .update(conversationThreads)
          .set({
            lastMessagePreview: messageBody.slice(0, 140),
            lastMessageAt: now,
            updatedAt: now
          })
          .where(eq(conversationThreads.id, thread.id));

        if (direction === "outbound") {
          await tx.insert(outboxEvents).values({
            type: "message.send",
            payload: {
              messageId: message?.id ?? null
            },
            createdAt: now
          });
        }
      }

      return { thread, message: messageRecord };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "thread_create_failed";
    const status = message === "contact_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEvent({
    actor,
    action: "thread.created",
    entityType: "conversation_thread",
    entityId: result.thread.id,
    meta: { channel: result.thread.channel, status: result.thread.status, state: result.thread.state }
  });

  if (result.message) {
    await recordAuditEvent({
      actor,
      action: direction === "inbound" ? "message.received" : "message.queued",
      entityType: "conversation_message",
      entityId: result.message.id,
      meta: { threadId: result.thread.id, channel }
    });
  }

  return NextResponse.json({
    thread: {
      id: result.thread.id,
      status: result.thread.status,
      state: result.thread.state,
      channel: result.thread.channel,
      subject: result.thread.subject ?? null,
      stateUpdatedAt: result.thread.stateUpdatedAt
        ? result.thread.stateUpdatedAt.toISOString()
        : null,
      leadId: result.thread.leadId ?? null,
      contactId: result.thread.contactId ?? null,
      propertyId: result.thread.propertyId ?? null
    }
  });
}
