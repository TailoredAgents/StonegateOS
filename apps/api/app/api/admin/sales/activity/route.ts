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

  const agentDraftCount = rows.filter((row) => row.action.startsWith("sales.autopilot.") || row.action.startsWith("sales.agent.draft.")).length;
  const agentAutosendCount = rows.filter((row) => row.action === "message.retry" || row.action.startsWith("sales.agent.autosend.")).length;

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
