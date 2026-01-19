import { DateTime } from "luxon";
import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLogs,
  callCoaching,
  callRecords,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  leads,
  policySettings,
  teamMembers
} from "@/db";
import { asc } from "drizzle-orm";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type SalesScorecardConfig = {
  timezone: string;
  businessStartHour: number;
  businessEndHour: number;
  speedToLeadMinutes: number;
  followupGraceMinutes: number;
  followupStepsMinutes: number[];
  followupSameDayLocalTime: string;
  followupNextDayMorningLocalTime: string;
  followupNextDayAfternoonLocalTime: string;
  followupReactivationDays: number[];
  defaultAssigneeMemberId: string;
  trackingStartAt: string | null;
  weights: {
    speedToLead: number;
    followupCompliance: number;
    conversion: number;
    callQuality: number;
    responseTime: number;
  };
};

export const SALES_SCORECARD_POLICY_KEY = "sales_scorecard";

const DEFAULT_CONFIG: SalesScorecardConfig = {
  timezone: "America/New_York",
  businessStartHour: 8,
  businessEndHour: 19,
  speedToLeadMinutes: 5,
  followupGraceMinutes: 10,
  followupStepsMinutes: [30, 120],
  followupSameDayLocalTime: "18:30",
  followupNextDayMorningLocalTime: "10:30",
  followupNextDayAfternoonLocalTime: "17:30",
  followupReactivationDays: [7, 14],
  defaultAssigneeMemberId: "",
  trackingStartAt: null,
  weights: {
    speedToLead: 45,
    followupCompliance: 35,
    conversion: 10,
    callQuality: 10,
    responseTime: 0
  }
};

const LEGACY_FOLLOWUP_STEPS_MINUTES_V1 = [15, 120, 1440, 4320];
const LEGACY_FOLLOWUP_STEPS_MINUTES_V2 = [30, 120, 480, 1440, 2880, 10080, 20160];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function coerceTimeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return isValidTimeString(trimmed) ? trimmed : fallback;
}

function coerceDays(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const days = value
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.round(v))
    .filter((v) => v >= 2 && v <= 60);
  return days.length ? Array.from(new Set(days)).sort((a, b) => a - b) : fallback;
}

function stepsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function clampInt(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function coerceSteps(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const steps = value
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.round(v))
    .filter((v) => v > 0 && v <= 60 * 24 * 30);
  return steps.length ? steps : fallback;
}

function coerceWeights(value: unknown, fallback: SalesScorecardConfig["weights"]): SalesScorecardConfig["weights"] {
  if (!isRecord(value)) return fallback;
  const speedToLead = clampInt(value["speedToLead"], fallback.speedToLead, { min: 0, max: 100 });
  const followupCompliance = clampInt(value["followupCompliance"], fallback.followupCompliance, { min: 0, max: 100 });
  const conversion = clampInt(value["conversion"], fallback.conversion, { min: 0, max: 100 });
  const callQuality = clampInt(value["callQuality"], fallback.callQuality, { min: 0, max: 100 });
  const responseTime = clampInt(value["responseTime"], fallback.responseTime, { min: 0, max: 100 });

  // Migration shim: older configs used responseTime weight. If callQuality is missing/0 but responseTime exists,
  // treat responseTime as callQuality and disable responseTime in scoring.
  const hasCallQualityKey = Object.prototype.hasOwnProperty.call(value, "callQuality");
  const hasResponseKey = Object.prototype.hasOwnProperty.call(value, "responseTime");
  if (!hasCallQualityKey && hasResponseKey && callQuality === 0 && responseTime > 0) {
    return { speedToLead, followupCompliance, conversion, callQuality: responseTime, responseTime: 0 };
  }

  return { speedToLead, followupCompliance, conversion, callQuality, responseTime };
}

async function resolveFallbackDefaultAssigneeMemberId(db: DbExecutor): Promise<string> {
  const [member] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.active, true))
    .orderBy(asc(teamMembers.name), asc(teamMembers.createdAt))
    .limit(1);
  return member?.id ?? "";
}

export async function getSalesScorecardConfig(db: DbExecutor = getDb()): Promise<SalesScorecardConfig> {
  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
    .limit(1);

  const envDefault = process.env["SALES_DEFAULT_ASSIGNEE_ID"] ?? process.env["REMINDERS_DEFAULT_ASSIGNEE_ID"] ?? null;
  const fallbackDefault = envDefault && envDefault.trim().length > 0 ? envDefault.trim() : await resolveFallbackDefaultAssigneeMemberId(db);
  const base: SalesScorecardConfig = {
    ...DEFAULT_CONFIG,
    defaultAssigneeMemberId: fallbackDefault
  };

  const stored = row?.value;
  if (!stored || !isRecord(stored)) return base;

  const timezone = typeof stored["timezone"] === "string" && stored["timezone"].trim().length > 0 ? stored["timezone"].trim() : base.timezone;
  const businessStartHour = clampInt(stored["businessStartHour"], base.businessStartHour, { min: 0, max: 23 });
  const businessEndHour = clampInt(stored["businessEndHour"], base.businessEndHour, { min: 0, max: 23 });
  const speedToLeadMinutes = clampInt(stored["speedToLeadMinutes"], base.speedToLeadMinutes, { min: 1, max: 60 });
  const followupGraceMinutes = clampInt(stored["followupGraceMinutes"], base.followupGraceMinutes, { min: 0, max: 120 });
  const rawSteps = stored["followupStepsMinutes"];
  let followupStepsMinutes = coerceSteps(rawSteps, base.followupStepsMinutes);
  if (
    Array.isArray(rawSteps) &&
    (stepsEqual(followupStepsMinutes, LEGACY_FOLLOWUP_STEPS_MINUTES_V1) || stepsEqual(followupStepsMinutes, LEGACY_FOLLOWUP_STEPS_MINUTES_V2))
  ) {
    followupStepsMinutes = base.followupStepsMinutes;
  }
  const followupSameDayLocalTime = coerceTimeString(stored["followupSameDayLocalTime"], base.followupSameDayLocalTime);
  const followupNextDayMorningLocalTime = coerceTimeString(
    stored["followupNextDayMorningLocalTime"],
    base.followupNextDayMorningLocalTime
  );
  const followupNextDayAfternoonLocalTime = coerceTimeString(
    stored["followupNextDayAfternoonLocalTime"],
    base.followupNextDayAfternoonLocalTime
  );
  const followupReactivationDays = coerceDays(stored["followupReactivationDays"], base.followupReactivationDays);
  const defaultAssigneeMemberId =
    typeof stored["defaultAssigneeMemberId"] === "string" && stored["defaultAssigneeMemberId"].trim().length > 0
      ? stored["defaultAssigneeMemberId"].trim()
      : base.defaultAssigneeMemberId;
  const trackingStartAtRaw = typeof stored["trackingStartAt"] === "string" ? stored["trackingStartAt"].trim() : "";
  const trackingStartAt =
    trackingStartAtRaw.length > 0 && Number.isFinite(Date.parse(trackingStartAtRaw)) ? trackingStartAtRaw : base.trackingStartAt;
  const weights = coerceWeights(stored["weights"], base.weights);

  return {
    timezone,
    businessStartHour,
    businessEndHour,
    speedToLeadMinutes,
    followupGraceMinutes,
    followupStepsMinutes,
    followupSameDayLocalTime,
    followupNextDayMorningLocalTime,
    followupNextDayAfternoonLocalTime,
    followupReactivationDays,
    defaultAssigneeMemberId,
    trackingStartAt,
    weights
  };
}

export async function getDefaultSalesAssigneeMemberId(db: DbExecutor = getDb()): Promise<string> {
  const config = await getSalesScorecardConfig(db);
  return config.defaultAssigneeMemberId;
}

export function isWithinBusinessHours(createdAt: Date, config: SalesScorecardConfig): boolean {
  const local = DateTime.fromJSDate(createdAt, { zone: config.timezone });
  const start = local.set({ hour: config.businessStartHour, minute: 0, second: 0, millisecond: 0 });
  const end = local.set({ hour: config.businessEndHour, minute: 0, second: 0, millisecond: 0 });
  return local.isValid && start.isValid && end.isValid && local >= start && local <= end;
}

export function getLeadClockStart(createdAt: Date, config: SalesScorecardConfig): Date {
  const local = DateTime.fromJSDate(createdAt, { zone: config.timezone });
  const start = local.set({ hour: config.businessStartHour, minute: 0, second: 0, millisecond: 0 });
  const end = local.set({ hour: config.businessEndHour, minute: 0, second: 0, millisecond: 0 });

  if (local >= start && local <= end) {
    return createdAt;
  }

  if (local < start) {
    return start.toUTC().toJSDate();
  }

  return start.plus({ days: 1 }).toUTC().toJSDate();
}

export async function computeCallQualityForMember(params: {
  db: DbExecutor;
  memberId: string;
  since: Date;
  until: Date;
}): Promise<{ avgScore: number | null; count: number }> {
  const db = params.db;

  const rows = await db
    .select({
      avgScore: sql<number | null>`avg(${callCoaching.scoreOverall})`,
      count: sql<number>`count(*)`
    })
    .from(callCoaching)
    .innerJoin(callRecords, eq(callRecords.id, callCoaching.callRecordId))
    .leftJoin(contacts, eq(contacts.id, callRecords.contactId))
    .where(
      and(
        eq(callCoaching.memberId, params.memberId),
        eq(callCoaching.version, 1),
        gte(callCoaching.createdAt, params.since),
        lte(callCoaching.createdAt, params.until),
        sql`${callCoaching.rubric} = cast((case when lower(coalesce(${contacts.source}, '')) like 'outbound:%' then 'outbound' else 'inbound' end) as call_coaching_rubric)`
      )
    );

  const row = rows[0];
  const count = typeof row?.count === "number" && Number.isFinite(row.count) ? Math.round(row.count) : 0;
  const avgScoreRaw = typeof row?.avgScore === "number" && Number.isFinite(row.avgScore) ? row.avgScore : null;
  const avgScore = avgScoreRaw === null ? null : Math.max(0, Math.min(100, Math.round(avgScoreRaw)));
  return { avgScore, count };
}

export function getSpeedToLeadDeadline(createdAt: Date, config: SalesScorecardConfig): Date {
  const start = getLeadClockStart(createdAt, config);
  return new Date(start.getTime() + config.speedToLeadMinutes * 60_000);
}

export function buildLeadTag(leadId: string): string {
  return `[auto] leadId=${leadId}`;
}

export function buildContactTag(contactId: string): string {
  return `[auto] contactId=${contactId}`;
}

function parseLeadIdFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const match = notes.match(/leadId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function isDisqualifyMarker(notes: string | null): boolean {
  if (!notes) return false;
  return /\bdisqualify\s*=\s*[a-z0-9_]+\b/i.test(notes);
}

export async function getDisqualifiedContactIds(input: {
  db?: DbExecutor;
  contactIds: string[];
}): Promise<Set<string>> {
  const db = input.db ?? getDb();
  const ids = Array.from(new Set(input.contactIds)).filter(Boolean);
  if (!ids.length) return new Set<string>();

  const rows = await db
    .select({ contactId: crmTasks.contactId, notes: crmTasks.notes })
    .from(crmTasks)
    .where(and(inArray(crmTasks.contactId, ids), isNotNull(crmTasks.notes), ilike(crmTasks.notes, "%disqualify=%")))
    .limit(5000);

  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row.contactId !== "string" || !row.contactId) continue;
    const notes = typeof row.notes === "string" ? row.notes : null;
    if (isDisqualifyMarker(notes)) out.add(row.contactId);
  }
  return out;
}

export type SpeedToLeadResult = {
  leadId: string | null;
  contactId: string;
  createdAt: string;
  hasPhone: boolean;
  deadlineAt: string;
  firstCallAt: string | null;
  firstOutboundMessageAt: string | null;
  met: boolean;
};

export async function computeSpeedToLeadForMember(input: {
  db?: DbExecutor;
  memberId: string;
  since: Date;
  until: Date;
}): Promise<SpeedToLeadResult[]> {
  const db = input.db ?? getDb();
  const config = await getSalesScorecardConfig(db);

  const speedTaskRows = await db
    .select({
      taskId: crmTasks.id,
      contactId: crmTasks.contactId,
      taskCreatedAt: crmTasks.createdAt,
      taskDueAt: crmTasks.dueAt,
      taskStatus: crmTasks.status,
      taskUpdatedAt: crmTasks.updatedAt,
      taskNotes: crmTasks.notes,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.assignedTo, input.memberId),
        isNotNull(crmTasks.contactId),
        isNotNull(crmTasks.dueAt),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=speed_to_lead%"),
        gte(crmTasks.createdAt, input.since),
        lte(crmTasks.createdAt, input.until)
      )
    )
    .orderBy(desc(crmTasks.createdAt))
    .limit(800);

  if (!speedTaskRows.length) return [];

  const contactIds = Array.from(
    new Set(speedTaskRows.map((row) => (typeof row.contactId === "string" ? row.contactId : "")).filter(Boolean))
  );
  const disqualified = await getDisqualifiedContactIds({ db, contactIds });

  const taskIds = speedTaskRows.map((row) => row.taskId);
  const taskIdFromMeta = sql<string>`(${auditLogs.meta} ->> 'taskId')`;
  const callTimesByTask = new Map<string, Date>();
  const callTimesByContact = new Map<string, Date>();

  if (taskIds.length) {
    const callRows = await db
      .select({
        taskId: taskIdFromMeta,
        createdAt: auditLogs.createdAt
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "call.started"),
          eq(auditLogs.entityType, "contact"),
          eq(auditLogs.actorId, input.memberId),
          isNotNull(auditLogs.meta),
          inArray(taskIdFromMeta, taskIds),
          gte(auditLogs.createdAt, input.since),
          lte(auditLogs.createdAt, input.until)
        )
      )
      .limit(2000);

    for (const row of callRows) {
      const taskId = typeof row.taskId === "string" ? row.taskId : "";
      if (!taskId) continue;
      if (!(row.createdAt instanceof Date)) continue;
      const current = callTimesByTask.get(taskId);
      if (!current || row.createdAt.getTime() < current.getTime()) {
        callTimesByTask.set(taskId, row.createdAt);
      }
    }
  }

  if (contactIds.length) {
    const callRows = await db
      .select({
        contactId: auditLogs.entityId,
        createdAt: auditLogs.createdAt
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "call.started"),
          eq(auditLogs.entityType, "contact"),
          eq(auditLogs.actorId, input.memberId),
          isNotNull(auditLogs.entityId),
          inArray(auditLogs.entityId, contactIds),
          gte(auditLogs.createdAt, input.since),
          lte(auditLogs.createdAt, input.until)
        )
      )
      .limit(4000);

    for (const row of callRows) {
      if (typeof row.contactId !== "string" || !row.contactId) continue;
      if (!(row.createdAt instanceof Date)) continue;
      const current = callTimesByContact.get(row.contactId);
      if (!current || row.createdAt.getTime() < current.getTime()) {
        callTimesByContact.set(row.contactId, row.createdAt);
      }
    }

    const inboundCallRows = await db
      .select({ contactId: callRecords.contactId, createdAt: callRecords.createdAt })
      .from(callRecords)
      .where(
        and(
          eq(callRecords.direction, "inbound"),
          eq(callRecords.callStatus, "completed"),
          eq(callRecords.assignedTo, input.memberId),
          isNotNull(callRecords.contactId),
          isNotNull(callRecords.callDurationSec),
          gt(callRecords.callDurationSec, 0),
          inArray(callRecords.contactId, contactIds),
          gte(callRecords.createdAt, input.since),
          lte(callRecords.createdAt, input.until)
        )
      )
      .limit(4000);

    for (const row of inboundCallRows) {
      if (typeof row.contactId !== "string" || !row.contactId) continue;
      if (!(row.createdAt instanceof Date)) continue;
      const current = callTimesByContact.get(row.contactId);
      if (!current || row.createdAt.getTime() < current.getTime()) {
        callTimesByContact.set(row.contactId, row.createdAt);
      }
    }
  }

  const outboundByContact = new Map<string, Date>();
  if (contactIds.length) {
    const outboundRows = await db
      .select({
        contactId: conversationThreads.contactId,
        firstOutboundAt: sql<Date>`min(${conversationMessages.createdAt})`.as("first_outbound_at")
      })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .innerJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
      .where(
        and(
          eq(conversationMessages.direction, "outbound"),
          eq(conversationParticipants.participantType, "team"),
          eq(conversationParticipants.teamMemberId, input.memberId),
          gte(conversationMessages.createdAt, input.since),
          lte(conversationMessages.createdAt, input.until),
          isNotNull(conversationThreads.contactId),
          inArray(conversationThreads.contactId, contactIds)
        )
      )
      .groupBy(conversationThreads.contactId);

    for (const row of outboundRows) {
      if (row.firstOutboundAt instanceof Date && typeof row.contactId === "string" && row.contactId.length) {
        outboundByContact.set(row.contactId, row.firstOutboundAt);
      }
    }
  }

  return speedTaskRows
    .filter((row) => typeof row.contactId === "string" && row.contactId.length > 0 && !disqualified.has(row.contactId))
    .map((row) => {
      const contactId = row.contactId as string;
      const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
      const dueAt = row.taskDueAt instanceof Date ? row.taskDueAt : null;
      if (!dueAt) {
        const fallbackDeadline = getSpeedToLeadDeadline(row.taskCreatedAt instanceof Date ? row.taskCreatedAt : new Date(), config);
        return {
          leadId: parseLeadIdFromNotes(row.taskNotes),
          contactId,
          createdAt: row.taskCreatedAt instanceof Date ? row.taskCreatedAt.toISOString() : new Date().toISOString(),
          hasPhone,
          deadlineAt: fallbackDeadline.toISOString(),
          firstCallAt: null,
          firstOutboundMessageAt: null,
          met: false
        };
      }

      const clockStart = new Date(dueAt.getTime() - config.speedToLeadMinutes * 60_000);
      const fallbackCallAt = callTimesByContact.get(contactId) ?? null;
      const firstCallAtCandidate = callTimesByTask.get(row.taskId) ?? fallbackCallAt;
      const firstCallAt =
        firstCallAtCandidate && firstCallAtCandidate.getTime() >= clockStart.getTime()
          ? firstCallAtCandidate
          : null;
      const outboundCandidate = outboundByContact.get(contactId) ?? null;
      const firstOutboundAt =
        outboundCandidate && outboundCandidate.getTime() >= clockStart.getTime() ? outboundCandidate : null;

      const completionTouch =
        row.taskStatus === "completed" && row.taskUpdatedAt instanceof Date ? row.taskUpdatedAt : null;
      const touchAt = firstCallAt ?? completionTouch ?? firstOutboundAt;

      const met = Boolean(touchAt && touchAt.getTime() <= dueAt.getTime());

      return {
        leadId: parseLeadIdFromNotes(row.taskNotes),
        contactId,
        createdAt: clockStart.toISOString(),
        hasPhone,
        deadlineAt: dueAt.toISOString(),
        firstCallAt: firstCallAt ? firstCallAt.toISOString() : null,
        firstOutboundMessageAt: firstOutboundAt ? firstOutboundAt.toISOString() : null,
        met
      };
    });
}

export type FollowupComplianceResult = {
  totalDue: number;
  completedOnTime: number;
  completedLate: number;
  stillOpen: number;
};

export async function computeFollowupComplianceForMember(input: {
  db?: DbExecutor;
  memberId: string;
  since: Date;
  until: Date;
  graceMinutes: number;
}): Promise<FollowupComplianceResult> {
  const db = input.db ?? getDb();
  const graceMs = input.graceMinutes * 60_000;

  const config = await getSalesScorecardConfig(db);
  const trackingStartAt =
    config.trackingStartAt && Number.isFinite(Date.parse(config.trackingStartAt)) ? new Date(config.trackingStartAt) : null;
  const effectiveSince =
    trackingStartAt && trackingStartAt.getTime() > input.since.getTime() ? trackingStartAt : input.since;

  const rows = await db
    .select({
      contactId: crmTasks.contactId,
      dueAt: crmTasks.dueAt,
      status: crmTasks.status,
      updatedAt: crmTasks.updatedAt,
      notes: crmTasks.notes,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.assignedTo, input.memberId),
        isNotNull(crmTasks.dueAt),
        gte(crmTasks.dueAt, effectiveSince),
        lte(crmTasks.dueAt, input.until),
        gte(crmTasks.createdAt, effectiveSince),
        isNotNull(crmTasks.notes),
        or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%")),
        ilike(crmTasks.notes, "%kind=follow_up%")
      )
    )
    .limit(2000);

  const disqualified = await getDisqualifiedContactIds({
    db,
    contactIds: rows.map((row) => row.contactId).filter((id): id is string => typeof id === "string" && id.length > 0)
  });

  let totalDue = 0;
  let completedOnTime = 0;
  let completedLate = 0;
  let stillOpen = 0;

  for (const row of rows) {
    if (typeof row.contactId === "string" && disqualified.has(row.contactId)) continue;
    const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
    if (!hasPhone) continue;
    if (!(row.dueAt instanceof Date)) continue;
    totalDue += 1;
    if (row.status === "completed") {
      const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : null;
      if (updatedAt && updatedAt.getTime() <= row.dueAt.getTime() + graceMs) {
        completedOnTime += 1;
      } else {
        completedLate += 1;
      }
    } else {
      stillOpen += 1;
    }
  }

  return { totalDue, completedOnTime, completedLate, stillOpen };
}

export async function computeConversionForMember(input: {
  db?: DbExecutor;
  memberId: string;
  since: Date;
  until: Date;
}): Promise<{ totalLeads: number; booked: number; won: number }> {
  const db = input.db ?? getDb();

  const rows = await db
    .select({
      leadId: leads.id,
      contactId: leads.contactId,
      stage: crmPipeline.stage
    })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, leads.contactId))
    .where(
      and(
        eq(contacts.salespersonMemberId, input.memberId),
        gte(leads.createdAt, input.since),
        lte(leads.createdAt, input.until)
      )
    )
    .limit(2000);

  const disqualified = await getDisqualifiedContactIds({
    db,
    contactIds: rows.map((row) => row.contactId).filter((id): id is string => typeof id === "string" && id.length > 0)
  });

  const filteredRows = rows.filter((row) => !disqualified.has(row.contactId));
  const totalLeads = filteredRows.length;
  let booked = 0;
  let won = 0;
  for (const row of filteredRows) {
    const stage = row.stage ?? null;
    if (stage === "qualified" || stage === "won") booked += 1;
    if (stage === "won") won += 1;
  }
  return { totalLeads, booked, won };
}
