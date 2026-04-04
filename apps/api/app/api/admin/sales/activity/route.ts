import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, inArray, sql } from "drizzle-orm";
import { getDb, auditLogs, contacts, crmTasks, salesAgentNextActions, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { loadAppointmentPreservationOutcomeSummary } from "@/lib/appointment-preservation-outcomes";
import { loadObjectionSaveOutcomeSummary } from "@/lib/objection-save-outcomes";
import { loadQuoteCloseOutcomeSummary } from "@/lib/quote-close-outcomes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 90;

const DEFAULT_ACTIONS = [
  "call.started",
  "message.received",
  "message.queued",
  "message.retry",
  "sales.escalation.call.started",
  "sales.escalation.call.connected",
  "sales.touch.manual",
  "sales.disposition.set",
  "sales.autopilot.draft_created",
  "sales.autopilot.autosend",
  "sales.agent.draft.prepared",
  "sales.agent.draft.reused",
  "sales.agent.draft.skipped",
  "sales.agent.autosend.queued",
  "sales.agent.autosend.skipped",
  "inbox.alert.sent",
  "inbox.alert.failed",
  "crm.reminder.created",
  "crm.reminder.sent",
  "crm.reminder.failed"
];

type ReasonCount = { label: string; count: number };
type WinSignal = { label: string; detail: string };

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseRangeDays(value: string | null): number {
  if (!value) return DEFAULT_RANGE_DAYS;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_RANGE_DAYS;
  return Math.min(Math.floor(parsed), MAX_RANGE_DAYS);
}

function parseActionList(value: string | null): string[] {
  if (!value) return DEFAULT_ACTIONS;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ACTIONS;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function incrementReason(map: Map<string, number>, label: string | null | undefined) {
  if (typeof label !== "string") return;
  const normalized = label.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topReasonCounts(map: Map<string, number>, limit = 3): ReasonCount[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)))
    .slice(0, limit);
}

function summarizeHumanReviewReason(input: {
  summary: string | null;
  reason: string | null;
  facts: string[] | null;
}): string {
  const combined = [input.summary, input.reason, ...(Array.isArray(input.facts) ? input.facts : [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (combined.includes("hazard") || combined.includes("unsupported material")) return "Hazardous or unsupported material";
  if (combined.includes("high risk") && combined.includes("demo")) return "High-risk demo scope";
  if (combined.includes("outside the current service area") || combined.includes("known zip")) return "Out of area";
  if (combined.includes("supported services") || combined.includes("unsupported services")) return "Unsupported service scope";
  if (combined.includes("timing conflicts") || combined.includes("faster turnaround") || combined.includes("schedule assumptions")) {
    return "Scheduling conflict";
  }
  if (combined.includes("access or scope complexity") || combined.includes("multiple areas") || combined.includes("difficult access")) {
    return "Access or scope complexity";
  }
  if (combined.includes("photos, stated scope, and quote signals disagree") || combined.includes("conflict strongly enough")) {
    return "Pricing or scope mismatch";
  }
  if (combined.includes("frustrated") || combined.includes("dispute") || combined.includes("complaint risk")) {
    return "Frustrated or dispute risk";
  }
  return "Other human review";
}

function formatDispositionLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRatePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTouchKindLabel(value: string | null | undefined): string | null {
  if (value === "requested") return "Initial confirmation";
  if (value === "rescheduled") return "Reschedule confirmation";
  if (value === "reminder") return "Reminder";
  if (value === "other") return "Other touch";
  return null;
}

function buildSupervisorWins(input: {
  quoteClose: {
    attempts: number;
    bookRate: number;
    preferredChannel: "sms" | "dm" | null;
  };
  objectionSave: {
    attempts: number;
    reopenRate: number;
    preferredChannel: "sms" | "dm" | null;
  };
  appointmentPreservation: {
    attempts: number;
    completedRate: number;
    strongestTouchKind: string | null;
  };
  agentAutosendCount: number;
}): WinSignal[] {
  const wins: WinSignal[] = [];

  if (input.quoteClose.attempts >= 4 && input.quoteClose.bookRate >= 0.12) {
    wins.push({
      label: "Quote nudges are closing revenue",
      detail: input.quoteClose.preferredChannel
        ? `${input.quoteClose.preferredChannel.toUpperCase()} is the current close leader at ${formatRatePercent(input.quoteClose.bookRate)} booked.`
        : `${formatRatePercent(input.quoteClose.bookRate)} of recent quote follow-ups are booking.`,
    });
  }

  if (input.objectionSave.attempts >= 4 && input.objectionSave.reopenRate >= 0.25) {
    wins.push({
      label: "Objection saves are reopening leads",
      detail: input.objectionSave.preferredChannel
        ? `${input.objectionSave.preferredChannel.toUpperCase()} is reopening more objections at ${formatRatePercent(input.objectionSave.reopenRate)}.`
        : `${formatRatePercent(input.objectionSave.reopenRate)} of recent objection saves are reopening the conversation.`,
    });
  }

  if (input.appointmentPreservation.attempts >= 6 && input.appointmentPreservation.completedRate >= 0.5) {
    wins.push({
      label: "Booked jobs are being protected",
      detail: input.appointmentPreservation.strongestTouchKind
        ? `${formatTouchKindLabel(input.appointmentPreservation.strongestTouchKind) ?? "Current confirmation"} is the strongest touch at ${formatRatePercent(input.appointmentPreservation.completedRate)} completed.`
        : `${formatRatePercent(input.appointmentPreservation.completedRate)} of recent confirmation-loop touches stayed on track to completion.`,
    });
  }

  if (input.agentAutosendCount >= 3) {
    wins.push({
      label: "Autonomous follow-up volume is active",
      detail: `${input.agentAutosendCount} planner autosends were queued in this window without needing manual send work.`,
    });
  }

  return wins.slice(0, 3);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "audit.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const limit = parseLimit(searchParams.get("limit"));
  const rangeDays = parseRangeDays(searchParams.get("rangeDays"));
  const actorIdRaw = searchParams.get("memberId") ?? searchParams.get("actorId");
  const actorId = actorIdRaw && isUuid(actorIdRaw) ? actorIdRaw : null;
  const actions = parseActionList(searchParams.get("actions"));

  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);
  const filters = [gte(auditLogs.createdAt, since), inArray(auditLogs.action, actions)];
  if (actorId) {
    filters.push(eq(auditLogs.actorId, actorId));
  }

  const db = getDb();
  const [quoteCloseSummary, objectionSaveSummary, appointmentPreservationSummary] = await Promise.all([
    loadQuoteCloseOutcomeSummary(db, { windowStart: since }),
    loadObjectionSaveOutcomeSummary(db, { windowStart: since }),
    loadAppointmentPreservationOutcomeSummary(db, { windowStart: since }),
  ]);
  const rows = await db
    .select({
      id: auditLogs.id,
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      actorRole: auditLogs.actorRole,
      actorLabel: auditLogs.actorLabel,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      meta: auditLogs.meta,
      createdAt: auditLogs.createdAt,
      actorName: teamMembers.name
    })
    .from(auditLogs)
    .leftJoin(teamMembers, eq(auditLogs.actorId, teamMembers.id))
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const events = rows.map((row) => ({
    id: row.id,
    actor: {
      type: row.actorType,
      id: row.actorId,
      role: row.actorRole ?? null,
      label: row.actorLabel ?? null,
      name: row.actorName ?? null
    },
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString()
  }));

  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogs)
    .where(and(...filters));
  const total = Number(totalResult[0]?.count ?? 0);

  const holdFilters = [
    eq(salesAgentNextActions.actionType, "human_follow_up"),
    sql`${salesAgentNextActions.status} <> 'dismissed'`,
  ];
  const reviewFilters = [
    eq(crmTasks.status, "completed"),
    sql`${crmTasks.dueAt} is null`,
    ilike(crmTasks.title, "Agent review%"),
    gte(crmTasks.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  ];

  if (actorId) {
    holdFilters.push(eq(contacts.salespersonMemberId, actorId));
    reviewFilters.push(eq(contacts.salespersonMemberId, actorId));
  }

  const [activeHumanReviewResult, recentlyReviewedResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(salesAgentNextActions)
      .innerJoin(contacts, eq(salesAgentNextActions.contactId, contacts.id))
      .where(and(...holdFilters)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(crmTasks)
      .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
      .where(and(...reviewFilters)),
  ]);

  const holdReasonRows = await db
    .select({
      summary: salesAgentNextActions.summary,
      reason: salesAgentNextActions.reason,
      facts: salesAgentNextActions.facts,
    })
    .from(salesAgentNextActions)
    .innerJoin(contacts, eq(salesAgentNextActions.contactId, contacts.id))
    .where(and(...holdFilters))
    .limit(200);

  const lostReasonFilters = [
    gte(auditLogs.createdAt, since),
    eq(auditLogs.action, "sales.disposition.set"),
    sql`coalesce(${auditLogs.meta} ->> 'markLost', 'false') = 'true'`,
  ];
  if (actorId) {
    lostReasonFilters.push(eq(contacts.salespersonMemberId, actorId));
  }

  const lostReasonRows = await db
    .select({
      disposition: sql<string>`coalesce(${auditLogs.meta} ->> 'disposition', '')`,
    })
    .from(auditLogs)
    .leftJoin(contacts, sql`${auditLogs.entityType} = 'contact' and ${auditLogs.entityId} = ${contacts.id}::text`)
    .where(and(...lostReasonFilters))
    .limit(500);

  const holdReasonCounts = new Map<string, number>();
  for (const row of holdReasonRows) {
    incrementReason(
      holdReasonCounts,
      summarizeHumanReviewReason({
        summary: row.summary ?? null,
        reason: row.reason ?? null,
        facts: Array.isArray(row.facts) ? row.facts : null,
      }),
    );
  }

  const lostReasonCounts = new Map<string, number>();
  for (const row of lostReasonRows) {
    incrementReason(lostReasonCounts, formatDispositionLabel(row.disposition));
  }

  const agentDraftCount = rows.filter((row) => row.action.startsWith("sales.autopilot.") || row.action.startsWith("sales.agent.draft.")).length;
  const agentAutosendCount = rows.filter((row) => row.action === "message.retry" || row.action.startsWith("sales.agent.autosend.")).length;
  const topWins = buildSupervisorWins({
    quoteClose: {
      attempts: quoteCloseSummary.attempts,
      bookRate: quoteCloseSummary.bookRate,
      preferredChannel: quoteCloseSummary.learned.preferredChannel,
    },
    objectionSave: {
      attempts: objectionSaveSummary.attempts,
      reopenRate: objectionSaveSummary.reopenRate,
      preferredChannel: objectionSaveSummary.learned.preferredChannel,
    },
    appointmentPreservation: {
      attempts: appointmentPreservationSummary.attempts,
      completedRate: appointmentPreservationSummary.completedRate,
      strongestTouchKind: appointmentPreservationSummary.learned.strongestTouchKind,
    },
    agentAutosendCount,
  });

  return NextResponse.json({
    ok: true,
    rangeDays,
    since: since.toISOString(),
    limit,
    total,
    memberId: actorId,
    actions,
    events,
    supervisor: {
      activeHumanReviewCount: Number(activeHumanReviewResult[0]?.count ?? 0),
      recentlyReviewedCount: Number(recentlyReviewedResult[0]?.count ?? 0),
      agentDraftCount,
      agentAutosendCount,
      topWins,
      topHoldReasons: topReasonCounts(holdReasonCounts),
      topLostReasons: topReasonCounts(lostReasonCounts),
      quoteClose: {
        attempts: quoteCloseSummary.attempts,
        bookRate: quoteCloseSummary.bookRate,
        lostRate: quoteCloseSummary.lostRate,
        preferredChannel: quoteCloseSummary.learned.preferredChannel,
        keepSofter: quoteCloseSummary.learned.keepSofter,
      },
      objectionSave: {
        attempts: objectionSaveSummary.attempts,
        reopenRate: objectionSaveSummary.reopenRate,
        bookRate: objectionSaveSummary.bookRate,
        preferredChannel: objectionSaveSummary.learned.preferredChannel,
        keepSofter: objectionSaveSummary.learned.keepSofter,
      },
      appointmentPreservation: {
        attempts: appointmentPreservationSummary.attempts,
        completedRate: appointmentPreservationSummary.completedRate,
        canceledRate: appointmentPreservationSummary.canceledRate,
        noShowRate: appointmentPreservationSummary.noShowRate,
        strongestTouchKind: appointmentPreservationSummary.learned.strongestTouchKind,
        needsHumanBackup: appointmentPreservationSummary.learned.needsHumanBackup,
      },
    },
  });
}
