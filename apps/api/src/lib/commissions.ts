import { DateTime } from "luxon";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  commissionCrewPoolOverrideDays,
  commissionSettings,
  expenses,
  leads,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers,
} from "@/db";
import { savePayoutRunReportHtml } from "@/lib/payout-run-report";

export type CommissionSettingsRow = {
  key: string;
  timezone: string;
  payoutWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO: 1=Mon ... 7=Sun
  payoutHour: number;
  payoutMinute: number;
  salesRateBps: number;
  marketingRateBps: number;
  crewPoolRateBps: number;
  marketingMemberId: string | null;
};

const SETTINGS_KEY = "default";
export const DEMO_CREW_POOL_RATE_BPS = 3000;
const THIRTY_PERCENT_DAY_CREW_MEMBER_IDS = [
  "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
  "b45988bb-7417-48c5-af6d-fcdf71088282",
  "d52dafcd-c571-40ac-ac20-527e4031bc05",
] as const;

function asWeekday(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7
  ) {
    return value;
  }
  return 5;
}

export function bpsFromPercent(percent: number): number {
  return Math.round(percent * 100);
}

export function percentFromBps(bps: number): number {
  return bps / 100;
}

export async function getOrCreateCommissionSettings(
  db: DatabaseClient,
): Promise<CommissionSettingsRow> {
  const [existing] = await db
    .select({
      key: commissionSettings.key,
      timezone: commissionSettings.timezone,
      payoutWeekday: commissionSettings.payoutWeekday,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
      salesRateBps: commissionSettings.salesRateBps,
      marketingRateBps: commissionSettings.marketingRateBps,
      crewPoolRateBps: commissionSettings.crewPoolRateBps,
      marketingMemberId: commissionSettings.marketingMemberId,
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (existing)
    return { ...existing, payoutWeekday: asWeekday(existing.payoutWeekday) };

  let defaultMarketingMemberId: string | null = null;
  try {
    const [austin] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(sql`lower(${teamMembers.name}) like 'austin%'`)
      .limit(1);
    defaultMarketingMemberId = austin?.id ?? null;
  } catch {
    defaultMarketingMemberId = null;
  }

  await db
    .insert(commissionSettings)
    .values({
      key: SETTINGS_KEY,
      timezone: "America/New_York",
      payoutWeekday: 1,
      payoutHour: 12,
      payoutMinute: 0,
      salesRateBps: 750,
      marketingRateBps: 1000,
      crewPoolRateBps: 2500,
      marketingMemberId: defaultMarketingMemberId,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: commissionSettings.key });

  const [created] = await db
    .select({
      key: commissionSettings.key,
      timezone: commissionSettings.timezone,
      payoutWeekday: commissionSettings.payoutWeekday,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
      salesRateBps: commissionSettings.salesRateBps,
      marketingRateBps: commissionSettings.marketingRateBps,
      crewPoolRateBps: commissionSettings.crewPoolRateBps,
      marketingMemberId: commissionSettings.marketingMemberId,
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (!created) {
    throw new Error("commission_settings_missing");
  }

  return { ...created, payoutWeekday: asWeekday(created.payoutWeekday) };
}

export function resolveCurrentPayoutPeriod(
  now: Date,
  settings: Pick<
    CommissionSettingsRow,
    "timezone" | "payoutHour" | "payoutMinute"
  >,
) {
  const zoned = DateTime.fromJSDate(now).setZone(settings.timezone);
  const periodStart = zoned.startOf("week");
  const periodEnd = periodStart.plus({ weeks: 1 });
  const scheduledPayoutAt = periodEnd.set({
    hour: settings.payoutHour,
    minute: settings.payoutMinute,
    second: 0,
    millisecond: 0,
  });

  return {
    timezone: settings.timezone,
    periodStart: periodStart.toJSDate(),
    periodEnd: periodEnd.toJSDate(),
    scheduledPayoutAt: scheduledPayoutAt.toJSDate(),
  };
}

function roundCents(amount: number): number {
  return Math.round(amount);
}

function computeBpsAmount(baseCents: number, rateBps: number): number {
  return roundCents((baseCents * rateBps) / 10000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode =
    direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause =
    direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const causeCode =
    cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

export function isDemoServicesRequested(
  servicesRequested: string[] | null | undefined,
): boolean {
  if (!Array.isArray(servicesRequested) || servicesRequested.length === 0) {
    return false;
  }

  return servicesRequested.some((service) => {
    if (typeof service !== "string") return false;
    const normalized = service.trim().toLowerCase();
    return (
      normalized === "demo-hauloff" ||
      normalized.startsWith("demo_") ||
      normalized.startsWith("demo-")
    );
  });
}

function appointmentUsesThirtyPercentDayRule(memberIds: string[]): boolean {
  const selected = new Set(
    memberIds
      .map((memberId) => memberId.trim())
      .filter((memberId) => memberId.length > 0),
  );
  return THIRTY_PERCENT_DAY_CREW_MEMBER_IDS.every((memberId) =>
    selected.has(memberId),
  );
}

export function allocateCrewPoolCents(
  poolCents: number,
  crew: Array<{ memberId: string; splitBps: number }>,
): Array<{
  memberId: string;
  splitBps: number;
  cents: number;
  remainder: number;
}> {
  const totalSplitBps = crew.reduce(
    (sum, entry) => sum + Math.max(0, entry.splitBps ?? 0),
    0,
  );

  if (poolCents <= 0 || totalSplitBps <= 0 || crew.length === 0) {
    return [];
  }

  const allocations = crew.map((entry) => {
    const numerator = poolCents * entry.splitBps;
    const quotient = Math.floor(numerator / totalSplitBps);
    const remainder = numerator % totalSplitBps;
    return {
      memberId: entry.memberId,
      splitBps: entry.splitBps,
      cents: quotient,
      remainder,
    };
  });

  const allocated = allocations.reduce((sum, entry) => sum + entry.cents, 0);
  let remaining = poolCents - allocated;
  allocations.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.memberId.localeCompare(b.memberId);
  });

  for (let i = 0; i < allocations.length && remaining > 0; i += 1) {
    allocations[i]!.cents += 1;
    remaining -= 1;
  }

  return allocations;
}

async function getEffectiveCrewPoolRateBps(
  tx: Pick<DatabaseClient, "select">,
  input: {
    timezone: string;
    defaultCrewPoolRateBps: number;
    startAt: Date | null;
    crewMemberIds: string[];
    servicesRequested: string[];
  },
): Promise<{
  crewPoolRateBps: number;
  overrideLocalDate: string | null;
  source: "default" | "demo" | "override_day";
}> {
  if (isDemoServicesRequested(input.servicesRequested)) {
    return {
      crewPoolRateBps: DEMO_CREW_POOL_RATE_BPS,
      overrideLocalDate: null,
      source: "demo",
    };
  }

  if (
    !input.startAt ||
    !appointmentUsesThirtyPercentDayRule(input.crewMemberIds)
  ) {
    return {
      crewPoolRateBps: input.defaultCrewPoolRateBps,
      overrideLocalDate: null,
      source: "default",
    };
  }

  const localDate = DateTime.fromJSDate(input.startAt, {
    zone: input.timezone,
  }).toISODate();
  if (!localDate) {
    return {
      crewPoolRateBps: input.defaultCrewPoolRateBps,
      overrideLocalDate: null,
      source: "default",
    };
  }

  try {
    const [override] = await tx
      .select({
        crewPoolRateBps: commissionCrewPoolOverrideDays.crewPoolRateBps,
      })
      .from(commissionCrewPoolOverrideDays)
      .where(eq(commissionCrewPoolOverrideDays.localDate, localDate))
      .limit(1);

    return {
      crewPoolRateBps:
        override?.crewPoolRateBps ?? input.defaultCrewPoolRateBps,
      overrideLocalDate: override ? localDate : null,
      source: override ? "override_day" : "default",
    };
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return {
        crewPoolRateBps: input.defaultCrewPoolRateBps,
        overrideLocalDate: null,
        source: "default",
      };
    }
    throw error;
  }
}

async function refreshDraftPayoutReports(db: DatabaseClient): Promise<void> {
  const draftRuns = await db
    .select({ id: payoutRuns.id })
    .from(payoutRuns)
    .where(eq(payoutRuns.status, "draft"));

  for (const run of draftRuns) {
    await savePayoutRunReportHtml(db, run.id);
  }
}

export async function recalculateAppointmentCommissions(
  db: DatabaseClient,
  appointmentId: string,
): Promise<void> {
  let settings: CommissionSettingsRow;
  try {
    settings = await getOrCreateCommissionSettings(db);
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return;
    }
    throw error;
  }

  try {
    await db.transaction(async (tx) => {
      let row:
        | {
            id: string;
            status: string | null;
            finalTotalCents: number | null;
            startAt: Date | null;
            leadId: string | null;
            soldByMemberId: string | null;
            marketingMemberId: string | null;
          }
        | undefined;

      try {
        const [full] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            finalTotalCents: appointments.finalTotalCents,
            startAt: appointments.startAt,
            leadId: appointments.leadId,
            soldByMemberId: appointments.soldByMemberId,
            marketingMemberId: appointments.marketingMemberId,
          })
          .from(appointments)
          .where(eq(appointments.id, appointmentId))
          .limit(1);
        row = full;
      } catch (error) {
        const code = extractPgCode(error);
        if (code !== "42703") {
          throw error;
        }

        const [fallback] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            finalTotalCents: appointments.finalTotalCents,
            startAt: appointments.startAt,
            leadId: appointments.leadId,
          })
          .from(appointments)
          .where(eq(appointments.id, appointmentId))
          .limit(1);

        row = fallback
          ? {
              ...fallback,
              startAt: fallback.startAt,
              leadId: fallback.leadId,
              soldByMemberId: null,
              marketingMemberId: null,
            }
          : undefined;
      }

      if (!row) {
        throw new Error("appointment_not_found");
      }

      const baseCents =
        row.status === "completed" && typeof row.finalTotalCents === "number"
          ? row.finalTotalCents
          : null;

      try {
        await tx
          .delete(appointmentCommissions)
          .where(eq(appointmentCommissions.appointmentId, appointmentId));
      } catch (error) {
        const code = extractPgCode(error);
        if (code === "42P01" || code === "42703") {
          return;
        }
        throw error;
      }

      if (baseCents === null) {
        return;
      }

      let servicesRequested: string[] = [];
      if (row.leadId) {
        try {
          const [lead] = await tx
            .select({
              servicesRequested: leads.servicesRequested,
            })
            .from(leads)
            .where(eq(leads.id, row.leadId))
            .limit(1);
          servicesRequested = Array.isArray(lead?.servicesRequested)
            ? lead.servicesRequested
            : [];
        } catch (error) {
          const code = extractPgCode(error);
          if (code !== "42P01" && code !== "42703") {
            throw error;
          }
        }
      }

      const commissionRows: Array<typeof appointmentCommissions.$inferInsert> =
        [];

      const soldBy = row.soldByMemberId ?? null;
      if (soldBy) {
        commissionRows.push({
          appointmentId,
          memberId: soldBy,
          role: "sales",
          baseCents,
          amountCents: computeBpsAmount(baseCents, settings.salesRateBps),
          meta: { rateBps: settings.salesRateBps },
        });
      }

      const marketingMemberId =
        row.marketingMemberId ?? settings.marketingMemberId ?? null;
      if (marketingMemberId) {
        commissionRows.push({
          appointmentId,
          memberId: marketingMemberId,
          role: "marketing",
          baseCents,
          amountCents: computeBpsAmount(baseCents, settings.marketingRateBps),
          meta: { rateBps: settings.marketingRateBps },
        });
      }

      let crew: Array<{ memberId: string; splitBps: number }> = [];
      try {
        crew = await tx
          .select({
            memberId: appointmentCrewMembers.memberId,
            splitBps: appointmentCrewMembers.splitBps,
          })
          .from(appointmentCrewMembers)
          .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
      } catch (error) {
        const code = extractPgCode(error);
        if (code !== "42P01" && code !== "42703") {
          throw error;
        }
        crew = [];
      }

      const totalSplitBps = crew.reduce(
        (sum, entry) => sum + (entry.splitBps ?? 0),
        0,
      );
      if (crew.length > 0 && totalSplitBps > 0) {
        const effectiveCrewPool = await getEffectiveCrewPoolRateBps(tx, {
          timezone: settings.timezone,
          defaultCrewPoolRateBps: settings.crewPoolRateBps,
          startAt: row.startAt ?? null,
          crewMemberIds: crew.map((entry) => entry.memberId),
          servicesRequested,
        });
        const poolCents = computeBpsAmount(
          baseCents,
          effectiveCrewPool.crewPoolRateBps,
        );
        const allocations = allocateCrewPoolCents(poolCents, crew);

        for (const entry of allocations) {
          commissionRows.push({
            appointmentId,
            memberId: entry.memberId,
            role: "crew",
            baseCents,
            amountCents: entry.cents,
            meta: {
              poolRateBps: effectiveCrewPool.crewPoolRateBps,
              splitBps: entry.splitBps,
              totalSplitBps,
              poolSource: effectiveCrewPool.source,
              ...(effectiveCrewPool.overrideLocalDate
                ? { poolOverrideLocalDate: effectiveCrewPool.overrideLocalDate }
                : {}),
            },
          });
        }
      }

      if (commissionRows.length > 0) {
        try {
          await tx.insert(appointmentCommissions).values(
            commissionRows.map((rowInsert) => ({
              ...rowInsert,
              createdAt: new Date(),
              updatedAt: new Date(),
            })),
          );
        } catch (error) {
          const code = extractPgCode(error);
          if (code !== "42P01" && code !== "42703") {
            throw error;
          }
        }
      }
    });
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return;
    }
    throw error;
  }
}

export async function createOrGetCurrentPayoutRun(
  db: DatabaseClient,
  input: { actorId?: string | null },
): Promise<{ payoutRunId: string }> {
  const settings = await getOrCreateCommissionSettings(db);
  const period = resolveCurrentPayoutPeriod(new Date(), settings);

  const [existing] = await db
    .select({ id: payoutRuns.id, status: payoutRuns.status })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.periodStart, period.periodStart),
        eq(payoutRuns.periodEnd, period.periodEnd),
      ),
    )
    .limit(1);

  if (existing?.id) {
    if (existing.status === "draft") {
      await refreshDraftPayoutReports(db);
    }
    return { payoutRunId: existing.id };
  }

  const [created] = await db
    .insert(payoutRuns)
    .values({
      timezone: period.timezone,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      scheduledPayoutAt: period.scheduledPayoutAt,
      status: "draft",
      createdBy: input.actorId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: payoutRuns.id });

  if (!created?.id) throw new Error("payout_run_create_failed");
  await refreshDraftPayoutReports(db);
  return { payoutRunId: created.id };
}

export async function lockPayoutRun(
  db: DatabaseClient,
  input: { payoutRunId: string; actorId?: string | null },
): Promise<void> {
  const [run] = await db
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, input.payoutRunId))
    .limit(1);

  if (!run) throw new Error("payout_run_not_found");
  if (run.status !== "draft") return;

  await db.transaction(async (tx) => {
    await tx
      .delete(payoutRunLines)
      .where(eq(payoutRunLines.payoutRunId, input.payoutRunId));

    const commissionRows = await tx
      .select({
        memberId: appointmentCommissions.memberId,
        role: appointmentCommissions.role,
        amountCents:
          sql<number>`sum(${appointmentCommissions.amountCents})`.mapWith(
            Number,
          ),
      })
      .from(appointmentCommissions)
      .innerJoin(
        appointments,
        eq(appointmentCommissions.appointmentId, appointments.id),
      )
      .where(
        and(
          gte(appointments.completedAt, run.periodStart),
          lt(appointments.completedAt, run.periodEnd),
          eq(appointments.status, "completed"),
        ),
      )
      .groupBy(appointmentCommissions.memberId, appointmentCommissions.role);

    const adjustmentRows = await tx
      .select({
        memberId: payoutRunAdjustments.memberId,
        amountCents:
          sql<number>`sum(${payoutRunAdjustments.amountCents})`.mapWith(Number),
      })
      .from(payoutRunAdjustments)
      .where(eq(payoutRunAdjustments.payoutRunId, input.payoutRunId))
      .groupBy(payoutRunAdjustments.memberId);

    const adjustmentMap = new Map<string, number>();
    for (const row of adjustmentRows) {
      if (row.memberId)
        adjustmentMap.set(row.memberId, Number(row.amountCents ?? 0));
    }

    const memberIds = Array.from(
      new Set(
        commissionRows
          .map((row) => row.memberId)
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    const members = memberIds.length
      ? await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(inArray(teamMembers.id, memberIds))
      : [];
    const memberSet = new Set(members.map((m) => m.id));

    type Totals = {
      sales: number;
      marketing: number;
      crew: number;
      adjustments: number;
    };
    const totalsByMember = new Map<string, Totals>();
    for (const row of commissionRows) {
      const memberId = row.memberId;
      if (!memberId || !memberSet.has(memberId)) continue;
      const totals = totalsByMember.get(memberId) ?? {
        sales: 0,
        marketing: 0,
        crew: 0,
        adjustments: 0,
      };
      const cents = Number(row.amountCents ?? 0);
      if (row.role === "sales") totals.sales += cents;
      if (row.role === "marketing") totals.marketing += cents;
      if (row.role === "crew") totals.crew += cents;
      totalsByMember.set(memberId, totals);
    }

    for (const [memberId, adjustment] of adjustmentMap.entries()) {
      const totals = totalsByMember.get(memberId) ?? {
        sales: 0,
        marketing: 0,
        crew: 0,
        adjustments: 0,
      };
      totals.adjustments += adjustment;
      totalsByMember.set(memberId, totals);
    }

    const lines: Array<typeof payoutRunLines.$inferInsert> = [];
    for (const [memberId, totals] of totalsByMember.entries()) {
      const totalCents =
        totals.sales + totals.marketing + totals.crew + totals.adjustments;
      lines.push({
        payoutRunId: input.payoutRunId,
        memberId,
        salesCents: totals.sales,
        marketingCents: totals.marketing,
        crewCents: totals.crew,
        adjustmentsCents: totals.adjustments,
        totalCents,
      });
    }

    if (lines.length > 0) {
      await tx
        .insert(payoutRunLines)
        .values(lines.map((line) => ({ ...line, createdAt: new Date() })));
    }

    await tx
      .update(payoutRuns)
      .set({
        status: "locked",
        lockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payoutRuns.id, input.payoutRunId));
  });

  await savePayoutRunReportHtml(db, input.payoutRunId);
  await refreshDraftPayoutReports(db);
}

export async function markPayoutRunPaid(
  db: DatabaseClient,
  payoutRunId: string,
): Promise<void> {
  const now = new Date();

  await db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: payoutRuns.id,
        periodStart: payoutRuns.periodStart,
        periodEnd: payoutRuns.periodEnd,
        scheduledPayoutAt: payoutRuns.scheduledPayoutAt,
      })
      .from(payoutRuns)
      .where(eq(payoutRuns.id, payoutRunId))
      .limit(1);

    if (!run?.id) {
      throw new Error("payout_run_not_found");
    }

    await tx
      .update(payoutRuns)
      .set({ status: "paid", paidAt: now, updatedAt: now })
      .where(eq(payoutRuns.id, payoutRunId));

    const expenseMemo = `payout_run:${payoutRunId}`;

    const [existingExpense] = await tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(
        and(eq(expenses.source, "payout_run"), eq(expenses.memo, expenseMemo)),
      )
      .limit(1);

    if (existingExpense?.id) {
      return;
    }

    const [totals] = await tx
      .select({
        totalCents: sql<number>`sum(${payoutRunLines.totalCents})`.mapWith(
          Number,
        ),
      })
      .from(payoutRunLines)
      .where(eq(payoutRunLines.payoutRunId, payoutRunId))
      .limit(1);

    const totalCents = Number(totals?.totalCents ?? 0);
    if (totalCents <= 0) return;

    await tx.insert(expenses).values({
      amount: totalCents,
      currency: "USD",
      category: "Commissions",
      vendor: "Payouts",
      memo: expenseMemo,
      source: "payout_run",
      paidAt: run.scheduledPayoutAt ?? now,
      coverageStartAt: run.periodStart,
      coverageEndAt: run.periodEnd,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function recalculateCrewPoolOverrideDay(
  db: DatabaseClient,
  input: { localDate: string },
): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);
  const start = DateTime.fromISO(input.localDate, {
    zone: settings.timezone,
  }).startOf("day");
  if (!start.isValid) {
    throw new Error("invalid_local_date");
  }
  const end = start.plus({ days: 1 });

  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.startAt, start.toJSDate()),
        lt(appointments.startAt, end.toJSDate()),
      ),
    );

  for (const row of rows) {
    await recalculateAppointmentCommissions(db, row.id);
  }

  await refreshDraftPayoutReports(db);
}

export async function ensureCrewPoolOverrideDayEditable(
  db: DatabaseClient,
  input: { localDate: string },
): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);
  const start = DateTime.fromISO(input.localDate, {
    zone: settings.timezone,
  }).startOf("day");
  if (!start.isValid) {
    throw new Error("invalid_local_date");
  }

  const periodStart = start.startOf("week");
  const periodEnd = periodStart.plus({ weeks: 1 });

  const [existingRun] = await db
    .select({
      status: payoutRuns.status,
    })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.periodStart, periodStart.toJSDate()),
        eq(payoutRuns.periodEnd, periodEnd.toJSDate()),
      ),
    )
    .limit(1);

  if (existingRun && existingRun.status !== "draft") {
    throw new Error("payout_period_locked");
  }
}
