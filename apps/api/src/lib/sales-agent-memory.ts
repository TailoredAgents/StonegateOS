import { eq } from "drizzle-orm";
import { getDb, salesAgentMemories } from "@/db";
import type { OmniLeadContext } from "@/lib/omni-lead-context";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

function compactText(value: string | null | undefined, maxLen = 220): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

function dedupe(items: Array<string | null | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

export type SalesAgentMemoryRecord = {
  summary: string | null;
  customerIntent: string | null;
  jobType: string | null;
  pricingContext: string | null;
  objections: string[];
  channelPreference: string | null;
  lastPromisedNextStep: string | null;
  lastHumanSummary: string | null;
  bookingReadiness: string | null;
  quoteConfidence: string | null;
  missingFields: string[];
  factsJson: Record<string, unknown>;
};

export function buildSalesAgentMemory(context: OmniLeadContext): SalesAgentMemoryRecord {
  const serviceHints = dedupe([
    ...(context.latestLead?.servicesRequested ?? []),
    ...(context.instantQuote?.jobTypes ?? []),
    ...(context.formalQuote?.services ?? []),
  ]);

  const summaryBits = dedupe([
    context.contact.name ? `${context.contact.name} is the active contact.` : null,
    context.pipeline.stage ? `Pipeline stage is ${context.pipeline.stage}.` : null,
    context.derived.customerIntent ? `Intent looks like ${context.derived.customerIntent.replace(/_/g, " ")}.` : null,
    context.derived.pricingContext ? context.derived.pricingContext : null,
    context.nextAppointment
      ? `There is an appointment on file (${context.nextAppointment.type}, ${context.nextAppointment.status})${context.nextAppointment.startAt ? ` at ${context.nextAppointment.startAt}` : ""}.`
      : null,
    context.latestCall?.summary ? `Latest call: ${compactText(context.latestCall.summary, 240)}` : null,
    context.recentNotes[0]?.notes ? `Latest note: ${compactText(context.recentNotes[0].notes, 180)}` : null,
    context.derived.objections.length ? `Known objections: ${context.derived.objections.join(", ")}.` : null,
    context.derived.missingFields.length ? `Missing info: ${context.derived.missingFields.join(", ")}.` : null,
  ]);

  const summary = summaryBits.join(" ");

  const factsJson: Record<string, unknown> = {
    contact: context.contact,
    pipeline: context.pipeline,
    latestLead: context.latestLead,
    automation: context.automation,
    instantQuote: context.instantQuote,
    formalQuote: context.formalQuote,
    nextAppointment: context.nextAppointment,
    properties: context.properties,
    openTasks: context.openTasks,
    recentNotes: context.recentNotes,
    latestCall: context.latestCall,
    channelSummary: context.channelSummary,
    derived: context.derived,
  };

  return {
    summary: summary || null,
    customerIntent: context.derived.customerIntent,
    jobType: serviceHints[0] ?? null,
    pricingContext: context.derived.pricingContext,
    objections: context.derived.objections,
    channelPreference: context.derived.channelPreference,
    lastPromisedNextStep: compactText(context.derived.lastPromisedNextStep, 220),
    lastHumanSummary: compactText(context.derived.lastHumanSummary, 320),
    bookingReadiness: context.derived.bookingReadiness,
    quoteConfidence: context.derived.quoteConfidence,
    missingFields: context.derived.missingFields,
    factsJson,
  };
}

export async function upsertSalesAgentMemory(
  db: DbExecutor,
  input: { contactId: string; leadId?: string | null; memory: SalesAgentMemoryRecord; now?: Date },
) {
  const now = input.now ?? new Date();
  const values = {
    contactId: input.contactId,
    leadId: input.leadId ?? null,
    summary: input.memory.summary,
    customerIntent: input.memory.customerIntent,
    jobType: input.memory.jobType,
    pricingContext: input.memory.pricingContext,
    objections: input.memory.objections,
    channelPreference: input.memory.channelPreference,
    lastPromisedNextStep: input.memory.lastPromisedNextStep,
    lastHumanSummary: input.memory.lastHumanSummary,
    bookingReadiness: input.memory.bookingReadiness,
    quoteConfidence: input.memory.quoteConfidence,
    missingFields: input.memory.missingFields,
    factsJson: input.memory.factsJson,
    updatedAt: now,
    createdAt: now,
  };

  const [row] = await db
    .insert(salesAgentMemories)
    .values(values)
    .onConflictDoUpdate({
      target: salesAgentMemories.contactId,
      set: {
        leadId: values.leadId,
        summary: values.summary,
        customerIntent: values.customerIntent,
        jobType: values.jobType,
        pricingContext: values.pricingContext,
        objections: values.objections,
        channelPreference: values.channelPreference,
        lastPromisedNextStep: values.lastPromisedNextStep,
        lastHumanSummary: values.lastHumanSummary,
        bookingReadiness: values.bookingReadiness,
        quoteConfidence: values.quoteConfidence,
        missingFields: values.missingFields,
        factsJson: values.factsJson,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}

export async function getSalesAgentMemory(db: DbExecutor, contactId: string) {
  const [row] = await db
    .select()
    .from(salesAgentMemories)
    .where(eq(salesAgentMemories.contactId, contactId))
    .limit(1);
  return row ?? null;
}
