import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import {
  buildSalesAgentNextAction,
  upsertSalesAgentNextAction,
} from "@/lib/sales-agent-next-action";
import {
  buildSalesAgentMemory,
  upsertSalesAgentMemory,
  type SalesAgentMemoryRecord,
} from "@/lib/sales-agent-memory";
import { loadMediaQuoteOutcomeSummary } from "@/lib/media-quote-outcomes";
import { loadObjectionSaveOutcomeSummary } from "@/lib/objection-save-outcomes";
import { loadQuoteFollowupOutcomeSummary } from "@/lib/quote-followup-outcomes";
import { getSalesAutopilotPolicy } from "@/lib/policy";
import { isAdminRequest } from "../../../../../web/admin";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toMemoryRecord(memory: {
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
  factsJson: Record<string, unknown> | null;
}): SalesAgentMemoryRecord {
  return {
    summary: memory.summary,
    customerIntent: memory.customerIntent,
    jobType: memory.jobType,
    pricingContext: memory.pricingContext,
    objections: memory.objections,
    channelPreference: memory.channelPreference,
    lastPromisedNextStep: memory.lastPromisedNextStep,
    lastHumanSummary: memory.lastHumanSummary,
    bookingReadiness: memory.bookingReadiness,
    quoteConfidence: memory.quoteConfidence,
    missingFields: memory.missingFields,
    factsJson: memory.factsJson ?? {},
  };
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  const contactIdTrimmed = typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = request.nextUrl.searchParams.get("includeQuotePrice") === "1";
  const db = getDb();
  const autopilotPolicy = await getSalesAutopilotPolicy(db);
  const liveContext = await loadOmniLeadContext(db, {
    contactId: contactIdTrimmed,
    includeQuotePrice,
  });
  if (!liveContext) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const memory = await upsertSalesAgentMemory(db, {
    contactId: contactIdTrimmed,
    leadId: liveContext.latestLead?.id ?? null,
    memory: buildSalesAgentMemory(liveContext),
  });
  const mediaOutcomeSummary = await loadMediaQuoteOutcomeSummary(db);
  const objectionSaveOutcomeSummary = await loadObjectionSaveOutcomeSummary(db);
  const quoteFollowupOutcomeSummary = await loadQuoteFollowupOutcomeSummary(db);

  const nextAction = await upsertSalesAgentNextAction(db, {
    contactId: contactIdTrimmed,
    leadId: liveContext.latestLead?.id ?? null,
    action: buildSalesAgentNextAction({
      context: liveContext,
      memory: toMemoryRecord({
        summary: memory?.summary ?? null,
        customerIntent: memory?.customerIntent ?? null,
        jobType: memory?.jobType ?? null,
        pricingContext: memory?.pricingContext ?? null,
        objections: memory?.objections ?? [],
        channelPreference: memory?.channelPreference ?? null,
        lastPromisedNextStep: memory?.lastPromisedNextStep ?? null,
        lastHumanSummary: memory?.lastHumanSummary ?? null,
        bookingReadiness: memory?.bookingReadiness ?? null,
        quoteConfidence: memory?.quoteConfidence ?? null,
        missingFields: memory?.missingFields ?? [],
        factsJson: (memory?.factsJson as Record<string, unknown> | null) ?? {},
      }),
      objectionSaveOutcomeSummary,
      mediaOutcomeSummary,
      quoteFollowupOutcomeSummary,
      autopilotPolicy,
    }),
  });

  return NextResponse.json({
    ok: true,
    nextAction,
    liveContext,
  });
}
