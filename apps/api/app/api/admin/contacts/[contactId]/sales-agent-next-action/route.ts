import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, getTableColumns } from "drizzle-orm";
import { conversationMessages, conversationThreads, getDb, salesAgentNextActions } from "@/db";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import {
  buildSalesAgentNextAction,
  getSalesAgentNextAction,
  upsertSalesAgentNextAction,
} from "@/lib/sales-agent-next-action";
import {
  buildSalesAgentMemory,
  getSalesAgentMemory,
  upsertSalesAgentMemory,
  type SalesAgentMemoryRecord,
} from "@/lib/sales-agent-memory";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getSalesAutopilotPolicy, isSalesPlannerAutosendAllowed } from "@/lib/policy";
import { and, desc, inArray, sql } from "drizzle-orm";

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

function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSafeDraftPreparationAction(actionType: string | null | undefined): boolean {
  return (
    actionType === "reply_now" ||
    actionType === "follow_up_quote" ||
    actionType === "collect_missing_info" ||
    actionType === "handle_price_objection"
  );
}

function isSafePlannerAutosendAction(actionType: string | null | undefined): boolean {
  return typeof actionType === "string" && actionType.trim().length > 0;
}

function isPlannerActionDue(value: { dueAt?: string | Date | null } | null | undefined, now: Date): boolean {
  if (!value) return false;
  const dueAt =
    value.dueAt instanceof Date ? value.dueAt : parseIso(typeof value.dueAt === "string" ? value.dueAt : null);
  if (!dueAt) return true;
  return dueAt.getTime() <= now.getTime();
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "automation.read");
  if (permissionError) return permissionError;

  const { contactId } = await context.params;
  const contactIdTrimmed = typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = request.nextUrl.searchParams.get("includeQuotePrice") === "1";
  const db = getDb();
  const liveContext = await loadOmniLeadContext(db, {
    contactId: contactIdTrimmed,
    includeQuotePrice,
  });
  if (!liveContext) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  let memory = await getSalesAgentMemory(db, contactIdTrimmed);
  if (!memory) {
    memory = await upsertSalesAgentMemory(db, {
      contactId: contactIdTrimmed,
      leadId: liveContext.latestLead?.id ?? null,
      memory: buildSalesAgentMemory(liveContext),
    });
  }

  let nextAction = await getSalesAgentNextAction(db, contactIdTrimmed);
  if (!nextAction && memory) {
    nextAction = await upsertSalesAgentNextAction(db, {
      contactId: contactIdTrimmed,
      leadId: liveContext.latestLead?.id ?? null,
      action: buildSalesAgentNextAction({
        context: liveContext,
        memory: toMemoryRecord(memory),
      }),
    });
  }

  const autopilotPolicy = await getSalesAutopilotPolicy(db);
  const now = new Date();
  const latestDraftRows = await db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      channel: conversationMessages.channel,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        eq(conversationThreads.contactId, contactIdTrimmed),
        eq(conversationMessages.direction, "outbound"),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') = 'true'`,
        sql`coalesce(${conversationMessages.metadata} ->> 'aiSuggested', 'false') = 'true'`
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);
  const latestDraft = latestDraftRows[0] ?? null;
  const automationState =
    (liveContext.automation ?? []).find((row) => row?.channel === (nextAction?.channel ?? latestDraft?.channel ?? null)) ?? null;
  const draftCreatedAt = latestDraft?.createdAt instanceof Date ? latestDraft.createdAt : null;
  const draftIsOldEnough =
    draftCreatedAt instanceof Date &&
    now.getTime() - draftCreatedAt.getTime() >= Math.max(60_000, autopilotPolicy.plannerAutoSendMinDraftAgeMinutes * 60_000);
  const autosendPolicyAllowed = isSalesPlannerAutosendAllowed(autopilotPolicy, {
    channel: nextAction?.channel ?? latestDraft?.channel ?? null,
    actionType: nextAction?.actionType ?? null,
  });
  const autosendEligible = Boolean(
    autosendPolicyAllowed &&
      latestDraft &&
      draftIsOldEnough &&
      isSafePlannerAutosendAction(nextAction?.actionType ?? null) &&
      isPlannerActionDue(nextAction, now)
  );
  const executionState = automationState?.dnc
    ? {
        code: "blocked",
        label: "Blocked",
        detail: "Do not contact is active for this lead.",
        tone: "bad" as const,
      }
    : automationState?.humanTakeover
      ? {
          code: "human_takeover",
          label: "Human takeover",
          detail: "Automation is paused until a human hands this lead back.",
          tone: "warn" as const,
        }
      : automationState?.paused
        ? {
            code: "paused",
            label: "Paused",
            detail: "Automation is paused on the current planner channel.",
            tone: "warn" as const,
          }
        : autosendEligible
          ? {
              code: "autosend_due",
              label: "Due for autosend",
              detail: "The worker can send this follow-up automatically.",
              tone: "good" as const,
            }
          : latestDraft
            ? {
                code: "draft_ready",
                label: "Ready to send",
                detail: autopilotPolicy.plannerAutoSendEnabled && autopilotPolicy.mode !== "off" && !draftIsOldEnough
                  ? "Draft is ready and still aging before autosend."
                  : "Draft is ready for review and send.",
                tone: "neutral" as const,
              }
            : nextAction?.actionType === "wait_for_appointment"
              ? {
                  code: "waiting_for_appointment",
                  label: "Waiting on appointment",
                  detail: "This lead already has an upcoming appointment.",
                  tone: "good" as const,
                }
              : nextAction?.actionType === "do_not_contact"
                ? {
                    code: "blocked",
                    label: "Blocked",
                    detail: "Do not contact is active for this lead.",
                    tone: "bad" as const,
                  }
                : nextAction?.actionType && isSafeDraftPreparationAction(nextAction.actionType)
                  ? {
                      code: "draft_pending",
                      label: "Draft pending",
                      detail: "The agent should prepare the next draft automatically.",
                      tone: "neutral" as const,
                    }
                  : nextAction?.summary
                    ? {
                        code: "awaiting_action",
                        label: "Awaiting action",
                        detail: nextAction.summary,
                        tone: nextAction.priority === "urgent" ? ("bad" as const) : ("neutral" as const),
                      }
                    : null;

  return NextResponse.json({
    ok: true,
    nextAction,
    liveContext,
    executionState,
    latestDraft: latestDraft
      ? {
          id: latestDraft.id,
          threadId: latestDraft.threadId,
          channel: latestDraft.channel,
          createdAt: latestDraft.createdAt.toISOString(),
        }
      : null,
  });
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "automation.write");
  if (permissionError) return permissionError;

  const { contactId } = await context.params;
  const contactIdTrimmed = typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as { status?: string } | null;
  const nextStatus = typeof payload?.status === "string" ? payload.status.trim() : "";
  if (!nextStatus) {
    return NextResponse.json({ error: "status_required" }, { status: 400 });
  }
  if (!["open", "scheduled", "blocked", "dismissed"].includes(nextStatus)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(salesAgentNextActions)
    .set({
      status: nextStatus,
      updatedAt: now,
    })
    .where(eq(salesAgentNextActions.contactId, contactIdTrimmed))
    .returning({
      ...getTableColumns(salesAgentNextActions),
    });

  if (!updated) {
    return NextResponse.json({ error: "next_action_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "sales_agent.next_action.update",
    entityType: "sales_agent_next_action",
    entityId: updated.id,
    meta: {
      contactId: contactIdTrimmed,
      status: nextStatus,
    },
  });

  return NextResponse.json({
    ok: true,
    nextAction: updated,
  });
}
