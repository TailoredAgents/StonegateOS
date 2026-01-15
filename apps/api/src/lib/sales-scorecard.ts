import { DateTime } from "luxon";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLogs,
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
    responseTime: number;
    conversion: number;
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
    responseTime: 10,
    conversion: 10
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
  const responseTime = clampInt(value["responseTime"], fallback.responseTime, { min: 0, max: 100 });
  const conversion = clampInt(value["conversion"], fallback.conversion, { min: 0, max: 100 });
  return { speedToLead, followupCompliance, responseTime, conversion };
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

  const contactRows = await db
    .select({
      contactId: contacts.id,
      contactCreatedAt: contacts.createdAt,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.salespersonMemberId, input.memberId),
        gte(contacts.createdAt, input.since),
        lte(contacts.createdAt, input.until)
      )
    )
    .orderBy(desc(contacts.createdAt))
    .limit(500);

  const scorableContactRows = contactRows.filter((row) => Boolean((row.phoneE164 ?? row.phone ?? "").trim().length));
  if (!scorableContactRows.length) return [];

  const withinHours = scorableContactRows.filter((row) => isWithinBusinessHours(row.contactCreatedAt, config));
  if (!withinHours.length) return [];

  const contactIds = Array.from(new Set(withinHours.map((row) => row.contactId)));
  const disqualified = await getDisqualifiedContactIds({ db, contactIds });

  const completedSpeedTasks = await db
    .select({
      contactId: crmTasks.contactId,
      touchedAt: sql<Date>`min(${crmTasks.updatedAt})`.as("touched_at")
    })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.assignedTo, input.memberId),
        eq(crmTasks.status, "completed"),
        isNotNull(crmTasks.contactId),
        inArray(crmTasks.contactId, contactIds),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=speed_to_lead%"),
        gte(crmTasks.updatedAt, input.since),
        lte(crmTasks.updatedAt, input.until)
      )
    )
    .groupBy(crmTasks.contactId);

  const speedTaskTouchMap = new Map<string, Date>();
  for (const row of completedSpeedTasks) {
    if (typeof row.contactId === "string" && row.touchedAt instanceof Date) {
      speedTaskTouchMap.set(row.contactId, row.touchedAt);
    }
  }

  const firstCalls = await db
    .select({
      contactId: auditLogs.entityId,
      firstCallAt: sql<Date>`min(${auditLogs.createdAt})`.as("first_call_at")
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
    .groupBy(auditLogs.entityId);

  const callMap = new Map<string, Date>();
  for (const row of firstCalls) {
    if (typeof row.contactId === "string" && row.firstCallAt instanceof Date) {
      callMap.set(row.contactId, row.firstCallAt);
    }
  }

  const firstOutboundMessages = await db
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

  const outboundByContact = new Map<string, Date>();
  for (const row of firstOutboundMessages) {
    if (row.firstOutboundAt instanceof Date) {
      if (typeof row.contactId === "string" && row.contactId.length) {
        outboundByContact.set(row.contactId, row.firstOutboundAt);
      }
    }
  }

  return withinHours
    .filter((row) => !disqualified.has(row.contactId))
    .map((row) => {
    const hasPhone = true;
    const deadline = getSpeedToLeadDeadline(row.contactCreatedAt, config);
    const firstCallAt = callMap.get(row.contactId) ?? speedTaskTouchMap.get(row.contactId) ?? null;
    const firstOutboundAt = outboundByContact.get(row.contactId) ?? null;
    const met = hasPhone
      ? Boolean(firstCallAt && firstCallAt.getTime() <= deadline.getTime())
      : Boolean(firstOutboundAt && firstOutboundAt.getTime() <= deadline.getTime());

    return {
      leadId: null,
      contactId: row.contactId,
      createdAt: row.contactCreatedAt.toISOString(),
      hasPhone,
      deadlineAt: deadline.toISOString(),
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
