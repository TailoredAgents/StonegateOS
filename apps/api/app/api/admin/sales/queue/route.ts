import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  auditLogs,
  callRecords,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  salesAgentNextActions,
  properties
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getDisqualifiedContactIds, getLeadClockStart, getSalesScorecardConfig, getSpeedToLeadDeadline } from "@/lib/sales-scorecard";
import {
  evaluateSalesPlannerAutosendPolicy,
  getSalesPlannerActionClass,
  getSalesAutopilotPolicy,
  getSalesAutopilotChannelMode,
  getServiceAreaPolicy,
  isPostalCodeAllowed,
  isSalesAutopilotLiveReplyEnabled,
  normalizePostalCode,
} from "@/lib/policy";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import { buildSalesAgentNextAction, upsertSalesAgentNextAction } from "@/lib/sales-agent-next-action";
import { buildSalesAgentMemory, getSalesAgentMemory, upsertSalesAgentMemory } from "@/lib/sales-agent-memory";
import { getDmLiveAutopilotStates } from "@/lib/dm-autopilot";
import { ensureInboxThreadForContactChannel } from "@/lib/inbox";
import { loadAppointmentPreservationOutcomeSummary } from "@/lib/appointment-preservation-outcomes";
import { loadAppointmentReminderOutcomeSummary } from "@/lib/appointment-reminder-outcomes";
import { loadChannelHandoffOutcomeSummary } from "@/lib/channel-handoff-outcomes";
import { loadFirstResponseOutcomeSummary } from "@/lib/first-response-outcomes";
import { loadMediaQuoteOutcomeSummary } from "@/lib/media-quote-outcomes";
import { loadMissingInfoOutcomeSummary } from "@/lib/missing-info-outcomes";
import { loadObjectionSaveOutcomeSummary } from "@/lib/objection-save-outcomes";
import { loadQuoteFollowupOutcomeSummary } from "@/lib/quote-followup-outcomes";
import { loadQuoteAccuracyOutcomeSummary } from "@/lib/quote-accuracy-outcomes";
import { loadQuoteCloseOutcomeSummary } from "@/lib/quote-close-outcomes";
import { loadReactivationOutcomeSummary } from "@/lib/reactivation-outcomes";

function parseLeadId(notes: string | null): string | null {
  if (!notes) return null;
  const match = notes.match(/leadId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function isSpeedTask(title: string): boolean {
  const t = title.toLowerCase();
  return t.includes("5 min sla") || t.includes("sla");
}

function parseTaskKind(notes: string | null, title: string): "speed_to_lead" | "follow_up" {
  const raw = typeof notes === "string" ? notes : "";
  if (/\bkind=speed_to_lead\b/i.test(raw)) return "speed_to_lead";
  if (/\bkind=follow_up\b/i.test(raw)) return "follow_up";
  return isSpeedTask(title) ? "speed_to_lead" : "follow_up";
}

function actionPriorityScore(value: string | null | undefined): number {
  switch (value) {
    case "urgent":
      return 0;
    case "high":
      return 1;
    case "normal":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function draftReadinessScore(item: {
  nextAction?: { priority?: string | null } | null;
  draft?: { ready?: boolean | null } | null;
}): number {
  if (item.draft?.ready) {
    return actionPriorityScore(item.nextAction?.priority ?? "normal") - 0.5;
  }
  return actionPriorityScore(item.nextAction?.priority);
}

function isSafeDraftPreparationAction(actionType: string | null | undefined): boolean {
  return (
    actionType === "missed_call_recovery" ||
    actionType === "dm_sms_handoff" ||
    actionType === "reply_now" ||
    actionType === "follow_up_quote" ||
    actionType === "collect_missing_info" ||
    actionType === "handle_price_objection"
  );
}

const AGENT_ACTIVITY_ACTIONS = [
  "sales.agent.draft.prepared",
  "sales.agent.draft.reused",
  "sales.agent.draft.skipped",
  "sales.agent.autosend.queued",
  "sales.agent.autosend.skipped",
] as const;

function getMetaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function summarizeAgentActivity(row: {
  action: string;
  meta: Record<string, unknown> | null;
}): { kind: "draft" | "autosend"; summary: string; channel: string | null } {
  const actionType = getMetaString(row.meta, "actionType");
  const reason = getMetaString(row.meta, "reason");
  const channel = getMetaString(row.meta, "channel");
  if (row.action.startsWith("sales.agent.autosend.")) {
    return {
      kind: "autosend",
      channel,
      summary:
        row.action === "sales.agent.autosend.queued"
          ? actionType
            ? `Autosend queued for ${actionType}`
            : "Autosend queued"
          : reason
            ? `Autosend skipped: ${reason}`
            : "Autosend skipped",
    };
  }
  return {
    kind: "draft",
    channel,
    summary:
      row.action === "sales.agent.draft.prepared"
        ? actionType
          ? `Draft prepared for ${actionType}`
          : "Draft prepared"
        : row.action === "sales.agent.draft.reused"
          ? actionType
            ? `Draft reused for ${actionType}`
            : "Draft reused"
          : reason
            ? `Draft skipped: ${reason}`
            : "Draft skipped",
  };
}

function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isPlannerActionDue(value: { dueAt?: string | null } | null | undefined, now: Date): boolean {
  if (!value) return false;
  const dueAt = parseIso(value.dueAt ?? null);
  if (!dueAt) return true;
  return dueAt.getTime() <= now.getTime();
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);
  const serviceAreaPolicy = await getServiceAreaPolicy(db);
  const autopilotPolicy = await getSalesAutopilotPolicy(db);
  const appointmentPreservationOutcomeSummary = await loadAppointmentPreservationOutcomeSummary(db);
  const appointmentReminderOutcomeSummary = await loadAppointmentReminderOutcomeSummary(db);
  const channelHandoffOutcomeSummary = await loadChannelHandoffOutcomeSummary(db);
  const firstResponseOutcomeSummary = await loadFirstResponseOutcomeSummary(db);
  const mediaOutcomeSummary = await loadMediaQuoteOutcomeSummary(db);
  const missingInfoOutcomeSummary = await loadMissingInfoOutcomeSummary(db);
  const objectionSaveOutcomeSummary = await loadObjectionSaveOutcomeSummary(db);
  const quoteAccuracyOutcomeSummary = await loadQuoteAccuracyOutcomeSummary(db);
  const quoteCloseOutcomeSummary = await loadQuoteCloseOutcomeSummary(db);
  const quoteFollowupOutcomeSummary = await loadQuoteFollowupOutcomeSummary(db);
  const reactivationOutcomeSummary = await loadReactivationOutcomeSummary(db);

  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId")?.trim() || config.defaultAssigneeMemberId;

  const now = new Date();
  const autoSendMinDraftAgeMs = Math.max(60_000, autopilotPolicy.plannerAutoSendMinDraftAgeMinutes * 60_000);
  const trackingStartAt =
    config.trackingStartAt && Number.isFinite(Date.parse(config.trackingStartAt)) ? new Date(config.trackingStartAt) : null;
  const effectiveSince = trackingStartAt && trackingStartAt.getTime() < now.getTime() ? trackingStartAt : null;
  const rows = await db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      status: crmTasks.status,
      notes: crmTasks.notes,
      contactCreatedAt: contacts.createdAt,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      pipelineStage: crmPipeline.stage
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.assignedTo, memberId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.dueAt),
        isNotNull(crmTasks.notes),
        ...(effectiveSince ? [gte(crmTasks.createdAt, effectiveSince)] : []),
        or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%")),
        or(isNull(crmPipeline.stage), notInArray(crmPipeline.stage, ["won", "lost", "quoted"]))
      )
    )
    .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(100);

  const disqualified = await getDisqualifiedContactIds({
    db,
    contactIds: rows.map((row) => row.contactId)
  });

  const dedupedRows: typeof rows = [];
  const seenTaskKeys = new Set<string>();
  for (const row of rows) {
    if (disqualified.has(row.contactId)) continue;
    const kind = parseTaskKind(row.notes ?? null, row.title);
    const key = `${row.contactId}:${kind}`;
    if (seenTaskKeys.has(key)) continue;
    seenTaskKeys.add(key);
    dedupedRows.push(row);
  }

  const items: Array<{
    id: string;
    leadId: string | null;
    contact: {
      id: string;
      name: string;
      phone: string | null;
      postalCode: string | null;
      serviceAreaStatus: "unknown" | "ok" | "potentially_out_of_area";
    };
    title: string;
    dueAt: string | null;
    overdue: boolean;
    minutesUntilDue: number | null;
    kind: "speed_to_lead" | "follow_up";
  }> = [];

  const postalCodeByContactId = new Map<string, string>();
  const contactIdsForLookup = Array.from(new Set(dedupedRows.map((row) => row.contactId))).filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );

  if (contactIdsForLookup.length) {
    const propertyRows = await db
      .select({
        contactId: properties.contactId,
        postalCode: properties.postalCode,
        createdAt: properties.createdAt
      })
      .from(properties)
      .where(inArray(properties.contactId, contactIdsForLookup.slice(0, 500)))
      .orderBy(desc(properties.createdAt))
      .limit(1000);

    for (const row of propertyRows) {
      if (!row.contactId || !row.postalCode) continue;
      if (postalCodeByContactId.has(row.contactId)) continue;
      postalCodeByContactId.set(row.contactId, row.postalCode);
    }
  }

  function getServiceAreaStatus(postalCode: string | null): "unknown" | "ok" | "potentially_out_of_area" {
    const normalized = postalCode ? normalizePostalCode(postalCode) : "";
    if (!normalized || normalized === "00000") return "unknown";
    return isPostalCodeAllowed(normalized, serviceAreaPolicy) ? "ok" : "potentially_out_of_area";
  }

  function getContactPostalCode(contactId: string): string | null {
    const postal = postalCodeByContactId.get(contactId);
    if (!postal) return null;
    const normalized = normalizePostalCode(postal);
    if (!normalized || normalized === "00000") return null;
    return normalized;
  }

  for (const row of dedupedRows) {
    const rawKind = parseTaskKind(row.notes ?? null, row.title);
    let kind: "speed_to_lead" | "follow_up" = rawKind;
    let title = row.title;
    let effectiveDueAt = row.dueAt instanceof Date ? row.dueAt : null;
    if (rawKind === "speed_to_lead" && row.contactCreatedAt instanceof Date) {
      const clockStart = getLeadClockStart(row.contactCreatedAt, config);
      const withinHours = clockStart.getTime() === row.contactCreatedAt.getTime();
      if (!withinHours) {
        title = "Auto: Call overnight lead (5 min SLA at open)";
        effectiveDueAt = getSpeedToLeadDeadline(row.contactCreatedAt, config);
      }
    }

    const dueAtIso = effectiveDueAt ? effectiveDueAt.toISOString() : null;
    const dueMs = effectiveDueAt ? effectiveDueAt.getTime() : null;
    const isOverdue = typeof dueMs === "number" ? dueMs < now.getTime() : false;
    const minutesUntilDue = typeof dueMs === "number" ? Math.round((dueMs - now.getTime()) / 60_000) : null;

    const postalCode = getContactPostalCode(row.contactId);
    items.push({
      id: row.id,
      leadId: parseLeadId(row.notes ?? null),
      contact: {
        id: row.contactId,
        name: `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null,
        postalCode,
        serviceAreaStatus: getServiceAreaStatus(postalCode)
      },
      title,
      dueAt: dueAtIso,
      overdue: isOverdue,
      minutesUntilDue,
      kind
    });
  }

  const seenContactIds = Array.from(new Set(rows.map((row) => row.contactId)));
  const defaultRecentSince = new Date(now.getTime() - 7 * 24 * 60_000 * 60);
  const recentSince =
    effectiveSince && effectiveSince.getTime() > defaultRecentSince.getTime() ? effectiveSince : defaultRecentSince;
  const missingFilters = [
    eq(contacts.salespersonMemberId, memberId),
    gte(contacts.createdAt, recentSince),
    lte(contacts.createdAt, now),
    // Outbound prospects should never appear in Sales HQ.
    sql`lower(coalesce(${contacts.source}, '')) not like 'outbound:%'`,
    or(isNull(crmPipeline.stage), notInArray(crmPipeline.stage, ["won", "lost", "quoted"]))
  ];
  if (seenContactIds.length) {
    missingFilters.push(notInArray(contacts.id, seenContactIds.slice(0, 500)));
  }

  const missingRows = await db
    .select({
      id: contacts.id,
      createdAt: contacts.createdAt,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .where(
      and(...missingFilters)
    )
    .orderBy(desc(contacts.createdAt))
    .limit(25);

  const missingContactIds = missingRows.map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const missingHasSalesTasks = new Set<string>();
  const missingHasTouch = new Set<string>();
  const missingDisqualified = missingContactIds.length
    ? await getDisqualifiedContactIds({ db, contactIds: missingContactIds })
    : new Set<string>();

  const missingPropertyLookup = missingContactIds.filter((contactId) => !postalCodeByContactId.has(contactId));
  if (missingPropertyLookup.length) {
    const propertyRows = await db
      .select({
        contactId: properties.contactId,
        postalCode: properties.postalCode,
        createdAt: properties.createdAt
      })
      .from(properties)
      .where(inArray(properties.contactId, missingPropertyLookup.slice(0, 500)))
      .orderBy(desc(properties.createdAt))
      .limit(1000);

    for (const row of propertyRows) {
      if (!row.contactId || !row.postalCode) continue;
      if (postalCodeByContactId.has(row.contactId)) continue;
      postalCodeByContactId.set(row.contactId, row.postalCode);
    }
  }

  if (missingContactIds.length) {
    const salesTaskRows = await db
      .select({ contactId: crmTasks.contactId })
      .from(crmTasks)
      .where(
        and(
          inArray(crmTasks.contactId, missingContactIds.slice(0, 250)),
          isNotNull(crmTasks.notes),
          or(ilike(crmTasks.notes, "%kind=speed_to_lead%"), ilike(crmTasks.notes, "%kind=follow_up%"))
        )
      )
      .limit(1000);

    for (const task of salesTaskRows) {
      if (typeof task.contactId === "string" && task.contactId.length > 0) {
        missingHasSalesTasks.add(task.contactId);
      }
    }

    const callTouchRows = await db
      .select({ contactId: auditLogs.entityId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "call.started"),
          eq(auditLogs.entityType, "contact"),
          eq(auditLogs.actorId, memberId),
          isNotNull(auditLogs.entityId),
          inArray(auditLogs.entityId, missingContactIds.slice(0, 250)),
          gte(auditLogs.createdAt, recentSince),
          lte(auditLogs.createdAt, now)
        )
      )
      .limit(250);

    for (const row of callTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }

    const outboundTouchRows = await db
      .select({ contactId: conversationThreads.contactId })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .innerJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
      .where(
        and(
          eq(conversationMessages.direction, "outbound"),
          eq(conversationParticipants.participantType, "team"),
          eq(conversationParticipants.teamMemberId, memberId),
          isNotNull(conversationThreads.contactId),
          inArray(conversationThreads.contactId, missingContactIds.slice(0, 250)),
          gte(conversationMessages.createdAt, recentSince),
          lte(conversationMessages.createdAt, now)
        )
      )
      .limit(250);

    for (const row of outboundTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }

    const inboundCallTouchRows = await db
      .select({ contactId: callRecords.contactId })
      .from(callRecords)
      .where(
        and(
          eq(callRecords.direction, "inbound"),
          eq(callRecords.callStatus, "completed"),
          eq(callRecords.assignedTo, memberId),
          isNotNull(callRecords.contactId),
          isNotNull(callRecords.callDurationSec),
          gt(callRecords.callDurationSec, 0),
          inArray(callRecords.contactId, missingContactIds.slice(0, 250)),
          gte(callRecords.createdAt, recentSince),
          lte(callRecords.createdAt, now)
        )
      )
      .limit(250);

    for (const row of inboundCallTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }
  }

  for (const row of missingRows) {
    if (missingHasSalesTasks.has(row.id)) continue;
    if (missingHasTouch.has(row.id)) continue;
    if (missingDisqualified.has(row.id)) continue;

    const clockStart = getLeadClockStart(row.createdAt, config);
    const withinHours = clockStart.getTime() === row.createdAt.getTime();
    const deadline = getSpeedToLeadDeadline(row.createdAt, config);
    const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
    if (!hasPhone) continue;

    if (!withinHours) {
      const dueMs = clockStart.getTime();
      const postalCode = getContactPostalCode(row.id);
      items.push({
        id: `contact:${row.id}`,
        leadId: null,
        contact: {
          id: row.id,
          name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact",
          phone: row.phoneE164 ?? row.phone ?? null,
          postalCode,
          serviceAreaStatus: getServiceAreaStatus(postalCode)
        },
        title: "Auto: Call overnight lead (at open)",
        dueAt: clockStart.toISOString(),
        overdue: dueMs < now.getTime(),
        minutesUntilDue: Math.round((dueMs - now.getTime()) / 60_000),
        kind: "follow_up"
      });
      continue;
    }

    const dueMs = deadline.getTime();
    const postalCode = getContactPostalCode(row.id);
    items.push({
      id: `contact:${row.id}`,
      leadId: null,
      contact: {
        id: row.id,
        name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null,
        postalCode,
        serviceAreaStatus: getServiceAreaStatus(postalCode)
      },
      title: hasPhone ? "Auto: Call new lead (5 min SLA)" : "Auto: Message new lead (5 min SLA)",
      dueAt: deadline.toISOString(),
      overdue: dueMs < now.getTime(),
      minutesUntilDue: Math.round((dueMs - now.getTime()) / 60_000),
      kind: "speed_to_lead"
    });
  }

  const contactIds = Array.from(new Set(items.map((item) => item.contact.id))).filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const existingNextActions =
    contactIds.length > 0
      ? await db
          .select()
          .from(salesAgentNextActions)
          .where(inArray(salesAgentNextActions.contactId, contactIds))
      : [];
  const existingNextActionMap = new Map(existingNextActions.map((row) => [row.contactId, row]));
  const rebuiltNextActionMap = new Map<
    string,
    | {
        actionType: string;
        channel: string | null;
        priority: string;
        confidence: string;
        summary: string | null;
        dueAt: string | null;
      }
    | null
  >();
  const draftByContactId = new Map<
    string,
    | {
        threadId: string;
        channel: string;
        messageId: string;
        bodyPreview: string | null;
        createdAt: string;
        ready: true;
      }
    | null
  >();
  const agentActivityByContactId = new Map<
    string,
    | {
        action: string;
        kind: "draft" | "autosend";
        summary: string;
        channel: string | null;
        createdAt: string;
      }
    | null
  >();
  const threadByContactId = new Map<
    string,
    {
      any: { threadId: string; channel: string } | null;
      byChannel: Map<string, { threadId: string; channel: string }>;
    }
  >();
  const dmAutopilotByThreadId = new Map<string, { ready: boolean; meaningfulInboundCount: number }>();

  await Promise.all(
    contactIds.map(async (contactId) => {
      const existing = existingNextActionMap.get(contactId);
      const existingUpdatedAt = existing?.updatedAt instanceof Date ? existing.updatedAt.getTime() : null;
      const isFresh = typeof existingUpdatedAt === "number" && now.getTime() - existingUpdatedAt <= 30 * 60 * 1000;
      if (existing && isFresh) {
        rebuiltNextActionMap.set(contactId, {
          actionType: existing.actionType,
          channel: existing.channel ?? null,
          priority: existing.priority,
          confidence: existing.confidence,
          summary: existing.summary ?? null,
          dueAt: existing.dueAt instanceof Date ? existing.dueAt.toISOString() : null,
        });
        return;
      }

      const liveContext = await loadOmniLeadContext(db, {
        contactId,
        includeQuotePrice: true,
      });
      if (!liveContext) {
        rebuiltNextActionMap.set(contactId, null);
        return;
      }

      const memory =
        (await getSalesAgentMemory(db, contactId)) ??
        (await upsertSalesAgentMemory(db, {
          contactId,
          leadId: liveContext.latestLead?.id ?? null,
          memory: buildSalesAgentMemory(liveContext),
        }));

      if (!memory) {
        rebuiltNextActionMap.set(contactId, null);
        return;
      }

      const nextAction = await upsertSalesAgentNextAction(db, {
        contactId,
        leadId: liveContext.latestLead?.id ?? null,
        action: buildSalesAgentNextAction({
          context: liveContext,
          memory: {
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
            factsJson: (memory.factsJson as Record<string, unknown> | null) ?? {},
          },
          appointmentPreservationOutcomeSummary,
          appointmentReminderOutcomeSummary,
          channelHandoffOutcomeSummary,
          firstResponseOutcomeSummary,
          missingInfoOutcomeSummary,
          objectionSaveOutcomeSummary,
          mediaOutcomeSummary,
          quoteAccuracyOutcomeSummary,
          quoteCloseOutcomeSummary,
          reactivationOutcomeSummary,
          quoteFollowupOutcomeSummary,
          autopilotPolicy,
        }),
      });

      rebuiltNextActionMap.set(
        contactId,
        nextAction
          ? {
              actionType: nextAction.actionType,
              channel: nextAction.channel ?? null,
              priority: nextAction.priority,
              confidence: nextAction.confidence,
              summary: nextAction.summary ?? null,
              dueAt: nextAction.dueAt instanceof Date ? nextAction.dueAt.toISOString() : null,
            }
          : null,
      );
    }),
  );

  if (contactIds.length > 0) {
    const threadRows = await db
      .select({
        contactId: conversationThreads.contactId,
        threadId: conversationThreads.id,
        channel: conversationThreads.channel,
        lastMessageAt: conversationThreads.lastMessageAt,
        updatedAt: conversationThreads.updatedAt,
      })
      .from(conversationThreads)
      .where(inArray(conversationThreads.contactId, contactIds))
      .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
      .limit(1000);

    for (const row of threadRows) {
      if (!row.contactId) continue;
      const current =
        threadByContactId.get(row.contactId) ??
        { any: null, byChannel: new Map<string, { threadId: string; channel: string }>() };
      if (!current.any) {
        current.any = {
          threadId: row.threadId,
          channel: row.channel,
        };
      }
      if (!current.byChannel.has(row.channel)) {
        current.byChannel.set(row.channel, {
          threadId: row.threadId,
          channel: row.channel,
        });
      }
      threadByContactId.set(row.contactId, current);
    }

    await Promise.all(
      contactIds.map(async (contactId) => {
        const nextAction = rebuiltNextActionMap.get(contactId) ?? null;
        const targetChannel = nextAction?.channel ?? null;
        if (
          !targetChannel ||
          !isSafeDraftPreparationAction(nextAction?.actionType ?? null) ||
          (targetChannel !== "sms" && targetChannel !== "email" && targetChannel !== "dm")
        ) {
          return;
        }

        const current =
          threadByContactId.get(contactId) ??
          { any: null, byChannel: new Map<string, { threadId: string; channel: string }>() };
        if (current.byChannel.has(targetChannel)) return;

        const ensuredThreadId = await ensureInboxThreadForContactChannel(db, {
          contactId,
          channel: targetChannel,
          now,
        });
        if (!ensuredThreadId) return;

        const targetThread = { threadId: ensuredThreadId, channel: targetChannel };
        if (!current.any) current.any = targetThread;
        current.byChannel.set(targetChannel, targetThread);
        threadByContactId.set(contactId, current);
      }),
    );

    const draftRows = await db
      .select({
        contactId: conversationThreads.contactId,
        threadId: conversationMessages.threadId,
        channel: conversationMessages.channel,
        messageId: conversationMessages.id,
        body: conversationMessages.body,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .where(
        and(
          inArray(conversationThreads.contactId, contactIds),
          eq(conversationMessages.direction, "outbound"),
          sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') = 'true'`,
          sql`coalesce(${conversationMessages.metadata} ->> 'aiSuggested', 'false') = 'true'`
        )
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(500);

    for (const row of draftRows) {
      if (!row.contactId || draftByContactId.has(row.contactId)) continue;
      draftByContactId.set(row.contactId, {
        threadId: row.threadId,
        channel: row.channel,
        messageId: row.messageId,
        bodyPreview: row.body.trim().slice(0, 180) || null,
        createdAt: row.createdAt.toISOString(),
        ready: true,
      });
    }

    const auditRows = await db
      .select({
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        meta: auditLogs.meta,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.action, [...AGENT_ACTIVITY_ACTIONS]),
          gte(auditLogs.createdAt, new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(2000);

    const contactIdSet = new Set(contactIds);
    for (const row of auditRows) {
      const meta = (row.meta as Record<string, unknown> | null) ?? null;
      const metaContactId = getMetaString(meta, "contactId");
      const contactId =
        metaContactId ??
        (row.entityType === "contact" && typeof row.entityId === "string" && row.entityId.trim().length > 0
          ? row.entityId.trim()
          : null);
      if (!contactId || !contactIdSet.has(contactId) || agentActivityByContactId.has(contactId)) continue;
      const activity = summarizeAgentActivity({ action: row.action, meta });
      agentActivityByContactId.set(contactId, {
        action: row.action,
        kind: activity.kind,
        summary: activity.summary,
        channel: activity.channel,
        createdAt: row.createdAt.toISOString(),
      });
    }

    const dmThreadIds = [...new Set(
      [...threadByContactId.values()]
        .map((entry) => entry.byChannel.get("dm")?.threadId ?? null)
        .filter((value): value is string => Boolean(value)),
    )];
    if (dmThreadIds.length > 0) {
      const dmStates = await getDmLiveAutopilotStates(db, dmThreadIds);
      for (const [threadId, state] of dmStates.entries()) {
        dmAutopilotByThreadId.set(threadId, state);
      }
    }
  }

  const enrichedItems = items
    .map((item) => {
      const nextAction = rebuiltNextActionMap.get(item.contact.id) ?? null;
      const draft = draftByContactId.get(item.contact.id) ?? null;
      const lastAgentActivity = agentActivityByContactId.get(item.contact.id) ?? null;
      const threadInfo = threadByContactId.get(item.contact.id) ?? null;
      const draftTarget =
        (nextAction?.channel ? threadInfo?.byChannel.get(nextAction.channel) ?? null : null) ??
        threadInfo?.any ??
        null;
      const draftPreparationEligible = Boolean(
        !draft?.ready &&
          draftTarget?.threadId &&
          isSafeDraftPreparationAction(nextAction?.actionType ?? null),
      );
      const draftCreatedAt = parseIso(draft?.createdAt ?? null);
      const draftIsOldEnough =
        draftCreatedAt instanceof Date && now.getTime() - draftCreatedAt.getTime() >= autoSendMinDraftAgeMs;
      const plannerDue = isPlannerActionDue(nextAction, now);
      const effectiveChannel = draftTarget?.channel ?? draft?.channel ?? nextAction?.channel ?? null;
      const channelMode = getSalesAutopilotChannelMode(autopilotPolicy, effectiveChannel);
      const liveReplyAllowed = isSalesAutopilotLiveReplyEnabled(autopilotPolicy, effectiveChannel);
      const autosendPolicy = evaluateSalesPlannerAutosendPolicy(autopilotPolicy, {
        channel: effectiveChannel,
        actionType: nextAction?.actionType ?? null,
      });
      const autosendPolicyAllowed = autosendPolicy.allowed;
      const actionClass = getSalesPlannerActionClass(nextAction?.actionType ?? null);
      const dmLiveAutopilotState =
        effectiveChannel === "dm" && draftTarget?.threadId && actionClass === "live_reply"
          ? dmAutopilotByThreadId.get(draftTarget.threadId) ?? { ready: false, meaningfulInboundCount: 0 }
          : null;
      const dmLiveAutopilotBlocked = Boolean(
        effectiveChannel === "dm" &&
          actionClass === "live_reply" &&
          dmLiveAutopilotState &&
          !dmLiveAutopilotState.ready,
      );
      const autosendEligible = Boolean(
        autosendPolicyAllowed &&
          draft?.ready &&
          draftIsOldEnough &&
          !dmLiveAutopilotBlocked &&
          plannerDue,
      );
      const autosendBlockedReason = !draft?.ready
        ? null
        : !autopilotPolicy.plannerAutoSendEnabled || autopilotPolicy.mode === "off"
          ? "Autosend disabled"
          : dmLiveAutopilotBlocked
            ? `Messenger warm-up: ${dmLiveAutopilotState?.meaningfulInboundCount ?? 0} meaningful inbound message${(dmLiveAutopilotState?.meaningfulInboundCount ?? 0) === 1 ? "" : "s"}`
          : autosendPolicy.reason === "action_requires_full_mode"
            ? "Partial mode keeps this live reply approval-only"
            : !autosendPolicyAllowed
              ? "Mode or policy blocked"
          : !plannerDue
            ? "Waiting for due time"
            : !draftIsOldEnough
              ? "Draft aging"
              : null;
      const agentState = channelMode === "off"
        ? {
            code: "mode_off",
            label: "Off mode",
            detail: "This channel is drafts only. No automatic sending.",
            tone: "neutral" as const,
          }
        : autosendEligible
        ? {
            code: "autosend_due",
            label: "Due for autosend",
            detail: "Worker can send this follow-up automatically.",
            tone: "good" as const,
          }
        : draft?.ready
          ? {
              code: autosendBlockedReason === "Waiting for due time" ? "waiting_on_reply" : "draft_ready",
              label: autosendBlockedReason === "Waiting for due time" ? "Waiting on due time" : "Ready to send",
              detail: autosendBlockedReason ?? "Draft is ready for human review.",
              tone: autosendBlockedReason && autosendBlockedReason !== "Waiting for due time" ? ("warn" as const) : ("neutral" as const),
            }
          : draftPreparationEligible
            ? {
                code: "draft_pending",
                label: "Draft pending",
                detail: "Agent should prepare the next draft shortly.",
                tone: "neutral" as const,
              }
            : nextAction?.actionType === "wait_for_appointment"
              ? {
                  code: "waiting_for_appointment",
                  label: "Waiting on appointment",
                  detail: "Lead already has an upcoming appointment.",
                  tone: "good" as const,
                }
              : nextAction?.actionType === "human_follow_up"
                ? {
                    code: "human_takeover",
                    label: "Human takeover",
                    detail: nextAction?.summary ?? "Automation is blocked for this lead.",
                    tone: "warn" as const,
                  }
                : nextAction?.actionType === "do_not_contact"
                  ? {
                      code: "blocked",
                      label: "Blocked",
                      detail: "Do not contact is active.",
                      tone: "bad" as const,
                    }
                  : nextAction?.actionType
                    ? {
                        code: "awaiting_action",
                        label: "Awaiting action",
                        detail: nextAction.summary ?? "Agent is waiting for the next move.",
                        tone: nextAction.priority === "urgent" ? ("bad" as const) : ("neutral" as const),
                      }
                    : null;

      return {
        ...item,
        nextAction,
        draft,
        draftTarget: draftTarget
          ? {
              threadId: draftTarget.threadId,
              channel: draftTarget.channel,
            }
          : null,
        draftPreparationEligible,
        lastAgentActivity,
        agentState,
        autopilot: {
          mode: autopilotPolicy.mode,
          channelMode,
          liveReplyAllowed,
        },
      };
    })
    .sort((a, b) => {
      const priorityDiff = draftReadinessScore(a) - draftReadinessScore(b);
      if (priorityDiff !== 0) return priorityDiff;
      const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      return aDue - bDue;
    });

  return NextResponse.json({ ok: true, memberId, now: now.toISOString(), items: enrichedItems });
}
