import { and, desc, eq, ne } from "drizzle-orm";
import { appointments, conversationThreads, crmPipeline, getDb, instantQuotes, leads } from "@/db";
import { normalizePostalCode } from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

type AppointmentSnapshot = {
  id: string;
  startAt: Date | null;
  status: string;
  type: string;
};

type LeadSnapshot = {
  id: string;
  createdAt: Date;
  status: string;
  source: string | null;
  servicesRequested: string[];
  notes: string | null;
  propertyId: string | null;
  instantQuoteId: string | null;
  formPayload: Record<string, unknown> | null;
};

type InstantQuoteSnapshot = {
  id: string;
  zip: string;
  timeframe: string;
  jobTypes: string[];
  perceivedSize: string;
  notes: string | null;
  photoUrls: string[];
  priceLow: number | null;
  priceHigh: number | null;
};

export type OmniThreadFacts = {
  pipelineStage: string | null;
  pipelineNotes: string | null;
  latestLead: LeadSnapshot | null;
  instantQuote: InstantQuoteSnapshot | null;
  nextAppointment: AppointmentSnapshot | null;
  otherChannelThreads: Array<{
    id: string;
    channel: string;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }>;
  knownZip: string | null;
  hasKnownJob: boolean;
  hasPhotos: boolean;
  missingFields: string[];
};

function extractQuotePrice(aiResult: unknown): { priceLow: number | null; priceHigh: number | null } {
  if (!aiResult || typeof aiResult !== "object") return { priceLow: null, priceHigh: null };
  const record = aiResult as Record<string, unknown>;
  const low = record["priceLow"];
  const high = record["priceHigh"];
  return {
    priceLow: typeof low === "number" && Number.isFinite(low) ? low : null,
    priceHigh: typeof high === "number" && Number.isFinite(high) ? high : null
  };
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function loadOmniThreadFacts(
  db: DbExecutor,
  input: {
    threadId: string;
    contactId: string | null;
    threadPostalCode?: string | null;
    includeQuotePrice?: boolean;
  }
): Promise<OmniThreadFacts> {
  const includeQuotePrice = input.includeQuotePrice === true;

  let pipelineStage: string | null = null;
  let pipelineNotes: string | null = null;
  let latestLead: LeadSnapshot | null = null;
  let instantQuote: InstantQuoteSnapshot | null = null;
  let nextAppointment: AppointmentSnapshot | null = null;
  let otherChannelThreads: OmniThreadFacts["otherChannelThreads"] = [];

  if (input.contactId) {
    const [pipeline] = await db
      .select({ stage: crmPipeline.stage, notes: crmPipeline.notes })
      .from(crmPipeline)
      .where(eq(crmPipeline.contactId, input.contactId))
      .limit(1);

    pipelineStage = typeof pipeline?.stage === "string" ? pipeline.stage : null;
    pipelineNotes = typeof pipeline?.notes === "string" ? pipeline.notes : null;

    const [leadRow] = await db
      .select({
        id: leads.id,
        createdAt: leads.createdAt,
        status: leads.status,
        source: leads.source,
        servicesRequested: leads.servicesRequested,
        notes: leads.notes,
        propertyId: leads.propertyId,
        instantQuoteId: leads.instantQuoteId,
        formPayload: leads.formPayload
      })
      .from(leads)
      .where(eq(leads.contactId, input.contactId))
      .orderBy(desc(leads.createdAt), desc(leads.updatedAt))
      .limit(1);

    if (leadRow?.id) {
      latestLead = {
        id: leadRow.id,
        createdAt: leadRow.createdAt,
        status: leadRow.status,
        source: typeof leadRow.source === "string" ? leadRow.source : null,
        servicesRequested: Array.isArray(leadRow.servicesRequested) ? leadRow.servicesRequested : [],
        notes: leadRow.notes ?? null,
        propertyId: leadRow.propertyId ?? null,
        instantQuoteId: leadRow.instantQuoteId ?? null,
        formPayload: coerceRecord(leadRow.formPayload)
      };
    }

    const now = new Date();
    const apptRows = await db
      .select({
        id: appointments.id,
        startAt: appointments.startAt,
        status: appointments.status,
        type: appointments.type
      })
      .from(appointments)
      .where(and(eq(appointments.contactId, input.contactId), ne(appointments.status, "canceled")))
      .orderBy(desc(appointments.startAt), desc(appointments.createdAt))
      .limit(4);

    if (apptRows.length > 0) {
      const upcoming = apptRows
        .filter((row): row is typeof row & { startAt: Date } => row.startAt instanceof Date && row.startAt.getTime() >= now.getTime())
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
      const best = upcoming ?? apptRows[0]!;
      nextAppointment = {
        id: best.id,
        startAt: best.startAt ?? null,
        status: best.status,
        type: best.type
      };
    }

    otherChannelThreads = await db
      .select({
        id: conversationThreads.id,
        channel: conversationThreads.channel,
        lastMessageAt: conversationThreads.lastMessageAt,
        lastMessagePreview: conversationThreads.lastMessagePreview
      })
      .from(conversationThreads)
      .where(and(eq(conversationThreads.contactId, input.contactId), ne(conversationThreads.id, input.threadId)))
      .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
      .limit(4);
  }

  const instantQuoteId =
    typeof latestLead?.instantQuoteId === "string" && latestLead.instantQuoteId.trim().length > 0
      ? latestLead.instantQuoteId
      : null;

  if (instantQuoteId) {
    const [row] = await db
      .select({
        id: instantQuotes.id,
        zip: instantQuotes.zip,
        timeframe: instantQuotes.timeframe,
        jobTypes: instantQuotes.jobTypes,
        perceivedSize: instantQuotes.perceivedSize,
        notes: instantQuotes.notes,
        photoUrls: instantQuotes.photoUrls,
        aiResult: instantQuotes.aiResult
      })
      .from(instantQuotes)
      .where(eq(instantQuotes.id, instantQuoteId))
      .limit(1);

    if (row?.id) {
      const price = includeQuotePrice ? extractQuotePrice(row.aiResult) : { priceLow: null, priceHigh: null };
      instantQuote = {
        id: row.id,
        zip: row.zip,
        timeframe: row.timeframe,
        jobTypes: coerceStringArray(row.jobTypes),
        perceivedSize: row.perceivedSize,
        notes: row.notes ?? null,
        photoUrls: coerceStringArray(row.photoUrls),
        priceLow: price.priceLow,
        priceHigh: price.priceHigh
      };
    }
  }

  const zipCandidates = [
    normalizePostalCode(input.threadPostalCode ?? null),
    instantQuote ? normalizePostalCode(instantQuote.zip) : null,
    (() => {
      const leadZip = latestLead?.formPayload?.["zip"];
      return typeof leadZip === "string" ? normalizePostalCode(leadZip) : null;
    })()
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const knownZip = zipCandidates[0] ?? null;
  const hasKnownJob =
    Boolean(instantQuote && (instantQuote.jobTypes.length > 0 || instantQuote.perceivedSize.trim().length > 0)) ||
    Boolean(latestLead && latestLead.servicesRequested.length > 0);
  const hasPhotos = Boolean(instantQuote && instantQuote.photoUrls.length > 0);

  const missingFields: string[] = [];
  if (!knownZip) missingFields.push("zip");
  if (!hasKnownJob) missingFields.push("items");
  if (!nextAppointment) {
    const tf =
      typeof instantQuote?.timeframe === "string" && instantQuote.timeframe.trim().length > 0
        ? instantQuote.timeframe.trim()
        : typeof latestLead?.formPayload?.["timeframe"] === "string"
          ? String(latestLead.formPayload["timeframe"]).trim()
          : "";
    if (!tf) missingFields.push("timing");
  }
  if (!hasPhotos && !missingFields.includes("items")) missingFields.push("photos");

  return {
    pipelineStage,
    pipelineNotes,
    latestLead,
    instantQuote,
    nextAppointment,
    otherChannelThreads,
    knownZip,
    hasKnownJob,
    hasPhotos,
    missingFields
  };
}
