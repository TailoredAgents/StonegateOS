import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  appointments,
  callRecords,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  instantQuotes,
  leadAutomationStates,
  leads,
  properties,
  quotes,
} from "@/db";
import { loadOmniThreadFacts } from "@/lib/omni-thread-context";
import { normalizePostalCode } from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function toIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractQuotePrice(aiResult: unknown): { priceLow: number | null; priceHigh: number | null } {
  if (!aiResult || typeof aiResult !== "object") return { priceLow: null, priceHigh: null };
  const record = aiResult as Record<string, unknown>;
  const low = record["priceLow"];
  const high = record["priceHigh"];
  return {
    priceLow: typeof low === "number" && Number.isFinite(low) ? low : null,
    priceHigh: typeof high === "number" && Number.isFinite(high) ? high : null,
  };
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function summarizePricing(input: {
  formalQuoteTotal?: string | number | null;
  instantQuoteLow?: number | null;
  instantQuoteHigh?: number | null;
}): string | null {
  if (input.formalQuoteTotal !== null && input.formalQuoteTotal !== undefined) {
    return `Formal quote on file: $${Number(input.formalQuoteTotal).toFixed(2)}`;
  }
  if (typeof input.instantQuoteLow === "number" && typeof input.instantQuoteHigh === "number") {
    return `Instant quote range on file: $${input.instantQuoteLow}-$${input.instantQuoteHigh}`;
  }
  return null;
}

function detectObjections(messages: Array<{ direction: string; body: string }>): string[] {
  const text = messages
    .filter((message) => message.direction === "inbound")
    .map((message) => message.body.toLowerCase())
    .join("\n");

  const results = new Set<string>();
  if (
    /(too high|too much|way too much|expensive|higher than|more than|overpriced|out of budget|can't do that price|cheaper company|better price)/.test(
      text,
    )
  ) {
    results.add("price");
  }
  if (
    /(need to talk to|need to check with|check with|ask my husband|ask my wife|ask my partner|talk to my partner|talk to the homeowner|check with the owner|landlord|owner)/.test(
      text,
    )
  ) {
    results.add("decision_maker");
  }
  if (
    /(not ready|later|next week|next month|not sure yet|still deciding|thinking about it|let me think|need to think|maybe later|hold off for now)/.test(
      text,
    )
  ) {
    results.add("timing");
  }
  if (/(shopping around|other companies|another company|another quote|other quote|comparing quotes|someone else)/.test(text)) {
    results.add("comparison_shopping");
  }
  if (/(don't call|stop|unsubscribe|leave me alone)/.test(text)) {
    results.add("do_not_contact");
  }
  return [...results];
}

function detectCustomerIntent(input: {
  latestLeadServices: string[];
  instantQuoteJobTypes: string[];
  recentMessages: Array<{ direction: string; body: string }>;
  nextAppointmentType: string | null;
}): string | null {
  if (input.nextAppointmentType) return "booked_or_scheduling";
  const allServices = [...input.latestLeadServices, ...input.instantQuoteJobTypes].join(" ").toLowerCase();
  if (allServices.includes("demo")) return "demolition_quote";
  if (allServices.includes("brush") || allServices.includes("land")) return "land_clearing_quote";
  if (allServices.length > 0) return "junk_removal_quote";

  const inboundText = input.recentMessages
    .filter((message) => message.direction === "inbound")
    .map((message) => message.body.toLowerCase())
    .join("\n");
  if (/(book|schedule|available|come out)/.test(inboundText)) return "booking_intent";
  if (/(quote|estimate|price|cost|how much)/.test(inboundText)) return "quote_intent";
  return null;
}

export type OmniLeadContext = {
  contact: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    phoneE164: string | null;
    source: string | null;
    salespersonMemberId: string | null;
  };
  pipeline: {
    stage: string | null;
    notes: string | null;
  };
  latestLead: {
    id: string;
    createdAt: string;
    status: string;
    source: string | null;
    servicesRequested: string[];
    notes: string | null;
    propertyId: string | null;
    instantQuoteId: string | null;
    formPayload: Record<string, unknown> | null;
  } | null;
  automation: Array<{
    channel: string;
    paused: boolean;
    dnc: boolean;
    humanTakeover: boolean;
    followupState: string | null;
    followupStep: number;
    nextFollowupAt: string | null;
  }>;
  instantQuote: {
    id: string;
    createdAt: string;
    zip: string;
    timeframe: string;
    jobTypes: string[];
    perceivedSize: string;
    notes: string | null;
    photoUrls: string[];
    priceLow: number | null;
    priceHigh: number | null;
  } | null;
  formalQuote: {
    id: string;
    status: string;
    total: string;
    services: string[];
    notes: string | null;
    createdAt: string;
  } | null;
  nextAppointment: {
    id: string;
    type: string;
    status: string;
    startAt: string | null;
    quotedTotalCents: number | null;
    finalTotalCents: number | null;
  } | null;
  properties: Array<{
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    createdAt: string;
  }>;
  openTasks: Array<{
    id: string;
    title: string;
    dueAt: string | null;
    assignedTo: string | null;
    notes: string | null;
  }>;
  recentNotes: Array<{
    id: string;
    title: string;
    notes: string | null;
    updatedAt: string;
  }>;
  latestCall: {
    id: string;
    direction: string;
    callStatus: string | null;
    createdAt: string;
    summary: string | null;
    transcript: string | null;
    extracted: Record<string, unknown> | null;
  } | null;
  channelSummary: Array<{
    channel: string;
    threadCount: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    lastMessageAt: string | null;
  }>;
  recentMessages: Array<{
    id: string;
    threadId: string;
    channel: string;
    direction: string;
    body: string;
    subject: string | null;
    participantName: string | null;
    mediaUrls: string[];
    createdAt: string;
    sentAt: string | null;
    receivedAt: string | null;
  }>;
  omniFacts: Awaited<ReturnType<typeof loadOmniThreadFacts>>;
  derived: {
    knownZip: string | null;
    objections: string[];
    channelPreference: string | null;
    dmEntrySource: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
    customerIntent: string | null;
    pricingContext: string | null;
    lastPromisedNextStep: string | null;
    lastHumanSummary: string | null;
    bookingReadiness: "booked" | "high" | "medium" | "low";
    quoteConfidence: "high" | "medium" | "low";
    missingFields: string[];
  };
};

export async function loadOmniLeadContext(
  db: DbExecutor,
  input: { contactId: string; includeQuotePrice?: boolean; messageLimit?: number },
): Promise<OmniLeadContext | null> {
  const contactId = input.contactId.trim();
  if (!contactId) return null;

  const includeQuotePrice = input.includeQuotePrice === true;
  const messageLimit = Math.min(Math.max(input.messageLimit ?? 40, 10), 100);

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      source: contacts.source,
      salespersonMemberId: contacts.salespersonMemberId,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact?.id) return null;

  const [pipeline, recentProperties, recentOpenTasks, recentNotes, latestLeadRow, latestCallRow, recentThreadRows, recentMessageRows, latestFormalQuoteRow] =
    await Promise.all([
      db
        .select({ stage: crmPipeline.stage, notes: crmPipeline.notes })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, contactId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: properties.id,
          addressLine1: properties.addressLine1,
          city: properties.city,
          state: properties.state,
          postalCode: properties.postalCode,
          createdAt: properties.createdAt,
        })
        .from(properties)
        .where(eq(properties.contactId, contactId))
        .orderBy(desc(properties.createdAt))
        .limit(6),
      db
        .select({
          id: crmTasks.id,
          title: crmTasks.title,
          dueAt: crmTasks.dueAt,
          assignedTo: crmTasks.assignedTo,
          notes: crmTasks.notes,
        })
        .from(crmTasks)
        .where(and(eq(crmTasks.contactId, contactId), eq(crmTasks.status, "open")))
        .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
        .limit(8),
      db
        .select({
          id: crmTasks.id,
          title: crmTasks.title,
          notes: crmTasks.notes,
          updatedAt: crmTasks.updatedAt,
        })
        .from(crmTasks)
        .where(and(eq(crmTasks.contactId, contactId), eq(crmTasks.status, "completed"), sql`${crmTasks.dueAt} is null`))
        .orderBy(desc(crmTasks.updatedAt))
        .limit(5),
      db
        .select({
          id: leads.id,
          createdAt: leads.createdAt,
          status: leads.status,
          source: leads.source,
          servicesRequested: leads.servicesRequested,
          notes: leads.notes,
          propertyId: leads.propertyId,
          instantQuoteId: leads.instantQuoteId,
          formPayload: leads.formPayload,
        })
        .from(leads)
        .where(eq(leads.contactId, contactId))
        .orderBy(desc(leads.createdAt), desc(leads.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: callRecords.id,
          direction: callRecords.direction,
          callStatus: callRecords.callStatus,
          createdAt: callRecords.createdAt,
          summary: callRecords.summary,
          transcript: callRecords.transcript,
          extracted: callRecords.extracted,
        })
        .from(callRecords)
        .where(and(eq(callRecords.contactId, contactId), isNotNull(callRecords.processedAt)))
        .orderBy(desc(callRecords.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: conversationThreads.id,
          channel: conversationThreads.channel,
          lastMessageAt: conversationThreads.lastMessageAt,
        })
        .from(conversationThreads)
        .where(eq(conversationThreads.contactId, contactId))
        .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
        .limit(20),
      db
        .select({
          id: conversationMessages.id,
          threadId: conversationMessages.threadId,
          channel: conversationMessages.channel,
          direction: conversationMessages.direction,
          subject: conversationMessages.subject,
          body: conversationMessages.body,
          mediaUrls: conversationMessages.mediaUrls,
          createdAt: conversationMessages.createdAt,
          sentAt: conversationMessages.sentAt,
          receivedAt: conversationMessages.receivedAt,
          participantName: conversationParticipants.displayName,
        })
        .from(conversationMessages)
        .innerJoin(conversationThreads, and(eq(conversationMessages.threadId, conversationThreads.id), eq(conversationThreads.contactId, contactId)))
        .leftJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
        .orderBy(desc(sql`coalesce(${conversationMessages.receivedAt}, ${conversationMessages.sentAt}, ${conversationMessages.createdAt})`))
        .limit(messageLimit),
      db
        .select({
          id: quotes.id,
          status: quotes.status,
          total: quotes.total,
          services: quotes.services,
          notes: quotes.notes,
          createdAt: quotes.createdAt,
        })
        .from(quotes)
        .where(eq(quotes.contactId, contactId))
        .orderBy(desc(quotes.createdAt), desc(quotes.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

  const omniFacts = await loadOmniThreadFacts(db, {
    threadId: ZERO_UUID,
    contactId,
    threadPostalCode: null,
    includeQuotePrice,
  });

  const latestLead = latestLeadRow
    ? {
        id: latestLeadRow.id,
        createdAt: latestLeadRow.createdAt.toISOString(),
        status: latestLeadRow.status,
        source: cleanText(latestLeadRow.source),
        servicesRequested: Array.isArray(latestLeadRow.servicesRequested) ? latestLeadRow.servicesRequested : [],
        notes: cleanText(latestLeadRow.notes),
        propertyId: latestLeadRow.propertyId ?? null,
        instantQuoteId: latestLeadRow.instantQuoteId ?? null,
        formPayload:
          latestLeadRow.formPayload && typeof latestLeadRow.formPayload === "object"
            ? (latestLeadRow.formPayload as Record<string, unknown>)
            : null,
      }
    : null;

  const automationRows =
    latestLead?.id
      ? await db
          .select({
            channel: leadAutomationStates.channel,
            paused: leadAutomationStates.paused,
            dnc: leadAutomationStates.dnc,
            humanTakeover: leadAutomationStates.humanTakeover,
            followupState: leadAutomationStates.followupState,
            followupStep: leadAutomationStates.followupStep,
            nextFollowupAt: leadAutomationStates.nextFollowupAt,
          })
          .from(leadAutomationStates)
          .where(eq(leadAutomationStates.leadId, latestLead.id))
          .orderBy(asc(leadAutomationStates.channel))
      : [];

  const latestInstantQuoteRow =
    latestLead?.instantQuoteId
      ? (
          await db
            .select({
              id: instantQuotes.id,
              createdAt: instantQuotes.createdAt,
              zip: instantQuotes.zip,
              timeframe: instantQuotes.timeframe,
              jobTypes: instantQuotes.jobTypes,
              perceivedSize: instantQuotes.perceivedSize,
              notes: instantQuotes.notes,
              photoUrls: instantQuotes.photoUrls,
              aiResult: instantQuotes.aiResult,
            })
            .from(instantQuotes)
            .where(eq(instantQuotes.id, latestLead.instantQuoteId))
            .limit(1)
        )[0] ?? null
      : null;

  const appointmentRows = await db
    .select({
      id: appointments.id,
      type: appointments.type,
      status: appointments.status,
      startAt: appointments.startAt,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
    })
    .from(appointments)
    .where(and(eq(appointments.contactId, contactId), ne(appointments.status, "canceled")))
    .orderBy(desc(appointments.startAt), desc(appointments.createdAt))
    .limit(10);

  const nowMs = Date.now();
  const upcomingAppointment =
    appointmentRows
      .filter((row): row is typeof row & { startAt: Date } => row.startAt instanceof Date && row.startAt.getTime() >= nowMs)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0] ?? appointmentRows[0] ?? null;

  const recentMessages = [...recentMessageRows]
    .reverse()
    .map((row) => ({
      id: row.id,
      threadId: row.threadId,
      channel: row.channel,
      direction: row.direction,
      body: row.body,
      subject: cleanText(row.subject),
      participantName: cleanText(row.participantName),
      mediaUrls: Array.isArray(row.mediaUrls) ? row.mediaUrls.filter(Boolean) : [],
      createdAt: row.createdAt.toISOString(),
      sentAt: toIso(row.sentAt),
      receivedAt: toIso(row.receivedAt),
    }));

  const threadIds = recentThreadRows.map((row) => row.id);
  const channelTimes =
    threadIds.length > 0
      ? await db
          .select({
            threadId: conversationMessages.threadId,
            channel: conversationMessages.channel,
            lastInboundAt: sql<Date | null>`max(case when ${conversationMessages.direction} = 'inbound' then coalesce(${conversationMessages.receivedAt}, ${conversationMessages.createdAt}) end)`,
            lastOutboundAt: sql<Date | null>`max(case when ${conversationMessages.direction} = 'outbound' then coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt}) end)`,
          })
          .from(conversationMessages)
          .where(inArray(conversationMessages.threadId, threadIds))
          .groupBy(conversationMessages.threadId, conversationMessages.channel)
      : [];

  const channelSummaryMap = new Map<
    string,
    { threadCount: number; lastInboundAt: Date | null; lastOutboundAt: Date | null; lastMessageAt: Date | null }
  >();
  for (const thread of recentThreadRows) {
    const existing = channelSummaryMap.get(thread.channel) ?? {
      threadCount: 0,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastMessageAt: null,
    };
    existing.threadCount += 1;
    if (thread.lastMessageAt && (!existing.lastMessageAt || thread.lastMessageAt > existing.lastMessageAt)) {
      existing.lastMessageAt = thread.lastMessageAt;
    }
    channelSummaryMap.set(thread.channel, existing);
  }
  for (const row of channelTimes) {
    const existing = channelSummaryMap.get(row.channel) ?? {
      threadCount: 0,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastMessageAt: null,
    };
    if (row.lastInboundAt && (!existing.lastInboundAt || row.lastInboundAt > existing.lastInboundAt)) {
      existing.lastInboundAt = row.lastInboundAt;
    }
    if (row.lastOutboundAt && (!existing.lastOutboundAt || row.lastOutboundAt > existing.lastOutboundAt)) {
      existing.lastOutboundAt = row.lastOutboundAt;
    }
    channelSummaryMap.set(row.channel, existing);
  }

  const channelSummary = [...channelSummaryMap.entries()]
    .map(([channel, row]) => ({
      channel,
      threadCount: row.threadCount,
      lastInboundAt: toIso(row.lastInboundAt),
      lastOutboundAt: toIso(row.lastOutboundAt),
      lastMessageAt: toIso(row.lastMessageAt),
    }))
    .sort((a, b) => Date.parse(b.lastMessageAt ?? "") - Date.parse(a.lastMessageAt ?? ""));

  const latestInbound = [...recentMessages]
    .filter((message) => message.direction === "inbound")
    .sort((a, b) => Date.parse(b.receivedAt ?? b.createdAt) - Date.parse(a.receivedAt ?? a.createdAt))[0] ?? null;
  const latestOutbound = [...recentMessages]
    .filter((message) => message.direction === "outbound")
    .sort((a, b) => Date.parse(b.sentAt ?? b.createdAt) - Date.parse(a.sentAt ?? a.createdAt))[0] ?? null;

  const objections = detectObjections(recentMessages);
  const channelPreference =
    latestInbound?.channel ??
    channelSummary.find((channel) => channel.threadCount > 0)?.channel ??
    null;
  const hasMessengerHistory = channelSummary.some((channel) => channel.channel === "dm" && channel.threadCount > 0);
  const latestLeadSource = latestLead?.source?.toLowerCase() ?? null;
  const latestLeadFormSource =
    typeof latestLead?.formPayload?.["source"] === "string"
      ? latestLead.formPayload["source"].toLowerCase()
      : null;
  const contactSource = contact.source?.toLowerCase() ?? null;
  const dmEntrySource =
    hasMessengerHistory
      ? latestLeadSource === "facebook_lead" ||
        latestLeadFormSource === "facebook_lead" ||
        contactSource === "facebook_lead"
        ? "facebook_ad_lead"
        : "organic_messenger"
      : null;

  const instantQuotePrice = latestInstantQuoteRow ? extractQuotePrice(latestInstantQuoteRow.aiResult) : { priceLow: null, priceHigh: null };
  const pricingContext = summarizePricing({
    formalQuoteTotal: latestFormalQuoteRow?.total ?? null,
    instantQuoteLow: instantQuotePrice.priceLow,
    instantQuoteHigh: instantQuotePrice.priceHigh,
  });
  const customerIntent = detectCustomerIntent({
    latestLeadServices: latestLead?.servicesRequested ?? [],
    instantQuoteJobTypes: latestInstantQuoteRow ? coerceStringArray(latestInstantQuoteRow.jobTypes) : [],
    recentMessages: recentMessages.map((message) => ({ direction: message.direction, body: message.body })),
    nextAppointmentType: upcomingAppointment?.type ?? null,
  });

  const knownZip =
    omniFacts.knownZip ??
    normalizePostalCode(recentProperties[0]?.postalCode ?? null) ??
    (latestInstantQuoteRow ? normalizePostalCode(latestInstantQuoteRow.zip) : null);
  const missingFields = Array.from(
    new Set([
      ...omniFacts.missingFields,
      ...(contact.phoneE164 || contact.phone ? [] : ["phone"]),
      ...(contact.email ? [] : ["email"]),
    ]),
  );
  const bookingReadiness =
    upcomingAppointment
      ? "booked"
      : customerIntent === "booked_or_scheduling"
        ? "high"
        : recentMessages.some((message) => message.direction === "inbound" && /\b(book|schedule|available|come out)\b/i.test(message.body))
          ? "high"
          : pricingContext
            ? "medium"
            : "low";
  const quoteConfidence =
    latestFormalQuoteRow
      ? "high"
      : latestInstantQuoteRow && (latestInstantQuoteRow.photoUrls?.length ?? 0) >= 2
        ? "medium"
        : latestInstantQuoteRow
          ? "low"
          : "low";
  const lastPromisedNextStep = cleanText(latestOutbound?.body);
  const lastHumanSummary =
    cleanText(latestCallRow?.summary) ??
    cleanText(recentNotes[0]?.notes) ??
    cleanText(recentNotes[0]?.title);

  return {
    contact: {
      id: contact.id,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || "Unknown contact",
      firstName: cleanText(contact.firstName),
      lastName: cleanText(contact.lastName),
      email: cleanText(contact.email),
      phone: cleanText(contact.phone),
      phoneE164: cleanText(contact.phoneE164),
      source: cleanText(contact.source),
      salespersonMemberId: contact.salespersonMemberId ?? null,
    },
    pipeline: {
      stage: pipeline?.stage ?? null,
      notes: cleanText(pipeline?.notes),
    },
    latestLead,
    automation: automationRows.map((row) => ({
      channel: row.channel,
      paused: row.paused,
      dnc: row.dnc,
      humanTakeover: row.humanTakeover,
      followupState: cleanText(row.followupState),
      followupStep: row.followupStep ?? 0,
      nextFollowupAt: toIso(row.nextFollowupAt),
    })),
    instantQuote: latestInstantQuoteRow
      ? {
          id: latestInstantQuoteRow.id,
          createdAt: latestInstantQuoteRow.createdAt.toISOString(),
          zip: latestInstantQuoteRow.zip,
          timeframe: latestInstantQuoteRow.timeframe,
          jobTypes: coerceStringArray(latestInstantQuoteRow.jobTypes),
          perceivedSize: latestInstantQuoteRow.perceivedSize,
          notes: cleanText(latestInstantQuoteRow.notes),
          photoUrls: coerceStringArray(latestInstantQuoteRow.photoUrls),
          priceLow: instantQuotePrice.priceLow,
          priceHigh: instantQuotePrice.priceHigh,
        }
      : null,
    formalQuote: latestFormalQuoteRow
      ? {
          id: latestFormalQuoteRow.id,
          status: latestFormalQuoteRow.status,
          total: String(latestFormalQuoteRow.total),
          services:
            Array.isArray(latestFormalQuoteRow.services)
              ? latestFormalQuoteRow.services.filter((item): item is string => typeof item === "string")
              : [],
          notes: cleanText(latestFormalQuoteRow.notes),
          createdAt: latestFormalQuoteRow.createdAt.toISOString(),
        }
      : null,
    nextAppointment: upcomingAppointment
      ? {
          id: upcomingAppointment.id,
          type: upcomingAppointment.type,
          status: upcomingAppointment.status,
          startAt: toIso(upcomingAppointment.startAt),
          quotedTotalCents: upcomingAppointment.quotedTotalCents ?? null,
          finalTotalCents: upcomingAppointment.finalTotalCents ?? null,
        }
      : null,
    properties: recentProperties.map((row) => ({
      id: row.id,
      addressLine1: row.addressLine1,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      createdAt: row.createdAt.toISOString(),
    })),
    openTasks: recentOpenTasks.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: toIso(row.dueAt),
      assignedTo: row.assignedTo ?? null,
      notes: cleanText(row.notes),
    })),
    recentNotes: recentNotes.map((row) => ({
      id: row.id,
      title: row.title,
      notes: cleanText(row.notes),
      updatedAt: row.updatedAt.toISOString(),
    })),
    latestCall: latestCallRow
      ? {
          id: latestCallRow.id,
          direction: latestCallRow.direction,
          callStatus: cleanText(latestCallRow.callStatus),
          createdAt: latestCallRow.createdAt.toISOString(),
          summary: cleanText(latestCallRow.summary),
          transcript: cleanText(latestCallRow.transcript),
          extracted:
            latestCallRow.extracted && typeof latestCallRow.extracted === "object"
              ? (latestCallRow.extracted as Record<string, unknown>)
              : null,
        }
      : null,
    channelSummary,
    recentMessages,
    omniFacts,
    derived: {
      knownZip,
      objections,
      channelPreference,
      dmEntrySource,
      customerIntent,
      pricingContext,
      lastPromisedNextStep,
      lastHumanSummary,
      bookingReadiness,
      quoteConfidence,
      missingFields,
    },
  };
}
