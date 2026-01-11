import { DateTime } from "luxon";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  commissionSettings,
  contacts,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers
} from "@/db";

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

function asWeekday(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6 || value === 7) {
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

export async function getOrCreateCommissionSettings(db: DatabaseClient): Promise<CommissionSettingsRow> {
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
      marketingMemberId: commissionSettings.marketingMemberId
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (existing) return { ...existing, payoutWeekday: asWeekday(existing.payoutWeekday) };

  await db
    .insert(commissionSettings)
    .values({
      key: SETTINGS_KEY,
      timezone: "America/New_York",
      payoutWeekday: 5,
      payoutHour: 12,
      payoutMinute: 0,
      salesRateBps: 750,
      marketingRateBps: 1000,
      crewPoolRateBps: 2500,
      marketingMemberId: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date()
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
      marketingMemberId: commissionSettings.marketingMemberId
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (!created) {
    throw new Error("commission_settings_missing");
  }

  return { ...created, payoutWeekday: asWeekday(created.payoutWeekday) };
}

export function resolveCurrentPayoutCutoff(now: Date, settings: Pick<CommissionSettingsRow, "timezone" | "payoutWeekday" | "payoutHour" | "payoutMinute">) {
  const zoned = DateTime.fromJSDate(now).setZone(settings.timezone);
  const thisWeekCutoff = zoned.set({
    weekday: settings.payoutWeekday,
    hour: settings.payoutHour,
    minute: settings.payoutMinute,
    second: 0,
    millisecond: 0
  });

  const cutoff = zoned >= thisWeekCutoff ? thisWeekCutoff : thisWeekCutoff.minus({ weeks: 1 });
  return {
    timezone: settings.timezone,
    cutoffAt: cutoff.toJSDate()
  };
}

export function defaultPayPeriodForCutoff(cutoffAt: Date, timezone: string): { start: Date; end: Date } {
  const cutoff = DateTime.fromJSDate(cutoffAt).setZone(timezone);
  const start = cutoff.minus({ days: 6, hours: 12 }).set({ second: 0, millisecond: 0 });
  return { start: start.toJSDate(), end: cutoff.toJSDate() };
}

function roundCents(amount: number): number {
  return Math.round(amount);
}

function computeBpsAmount(baseCents: number, rateBps: number): number {
  return roundCents((baseCents * rateBps) / 10000);
}

export async function recalculateAppointmentCommissions(db: DatabaseClient, appointmentId: string): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        finalTotalCents: appointments.finalTotalCents,
        contactId: appointments.contactId,
        soldByMemberId: appointments.soldByMemberId,
        marketingMemberId: appointments.marketingMemberId,
        contactSalespersonId: contacts.salespersonMemberId
      })
      .from(appointments)
      .leftJoin(contacts, eq(appointments.contactId, contacts.id))
      .where(eq(appointments.id, appointmentId))
      .limit(1);

    if (!row) {
      throw new Error("appointment_not_found");
    }

    const baseCents = row.status === "completed" && typeof row.finalTotalCents === "number" ? row.finalTotalCents : null;

    await tx.delete(appointmentCommissions).where(eq(appointmentCommissions.appointmentId, appointmentId));

    if (baseCents === null) {
      return;
    }

    const commissionRows: Array<typeof appointmentCommissions.$inferInsert> = [];

    const soldBy = row.soldByMemberId ?? row.contactSalespersonId ?? null;
    if (soldBy) {
      commissionRows.push({
        appointmentId,
        memberId: soldBy,
        role: "sales",
        baseCents,
        amountCents: computeBpsAmount(baseCents, settings.salesRateBps),
        meta: { rateBps: settings.salesRateBps }
      });
    }

    const marketingMemberId = row.marketingMemberId ?? settings.marketingMemberId ?? null;
    if (marketingMemberId) {
      commissionRows.push({
        appointmentId,
        memberId: marketingMemberId,
        role: "marketing",
        baseCents,
        amountCents: computeBpsAmount(baseCents, settings.marketingRateBps),
        meta: { rateBps: settings.marketingRateBps }
      });
    }

    const crew = await tx
      .select({
        memberId: appointmentCrewMembers.memberId,
        splitBps: appointmentCrewMembers.splitBps
      })
      .from(appointmentCrewMembers)
      .where(eq(appointmentCrewMembers.appointmentId, appointmentId));

    const totalSplitBps = crew.reduce((sum, entry) => sum + (entry.splitBps ?? 0), 0);
    if (crew.length > 0 && totalSplitBps > 0) {
      const poolCents = computeBpsAmount(baseCents, settings.crewPoolRateBps);
      const allocations = crew.map((entry) => {
        const numerator = poolCents * entry.splitBps;
        const quotient = Math.floor(numerator / totalSplitBps);
        const remainder = numerator % totalSplitBps;
        return {
          memberId: entry.memberId,
          splitBps: entry.splitBps,
          cents: quotient,
          remainder
        };
      });

      let allocated = allocations.reduce((sum, entry) => sum + entry.cents, 0);
      let remaining = poolCents - allocated;
      allocations.sort((a, b) => {
        if (b.remainder !== a.remainder) return b.remainder - a.remainder;
        return a.memberId.localeCompare(b.memberId);
      });

      for (let i = 0; i < allocations.length && remaining > 0; i += 1) {
        allocations[i]!.cents += 1;
        remaining -= 1;
      }

      for (const entry of allocations) {
        commissionRows.push({
          appointmentId,
          memberId: entry.memberId,
          role: "crew",
          baseCents,
          amountCents: entry.cents,
          meta: {
            poolRateBps: settings.crewPoolRateBps,
            splitBps: entry.splitBps,
            totalSplitBps
          }
        });
      }
    }

    if (commissionRows.length > 0) {
      await tx.insert(appointmentCommissions).values(
        commissionRows.map((rowInsert) => ({
          ...rowInsert,
          createdAt: new Date(),
          updatedAt: new Date()
        }))
      );
    }
  });
}

export async function createOrGetCurrentPayoutRun(db: DatabaseClient, input: { actorId?: string | null }): Promise<{ payoutRunId: string }> {
  const settings = await getOrCreateCommissionSettings(db);
  const { cutoffAt, timezone } = resolveCurrentPayoutCutoff(new Date(), settings);
  const period = defaultPayPeriodForCutoff(cutoffAt, timezone);

  const [existing] = await db
    .select({ id: payoutRuns.id })
    .from(payoutRuns)
    .where(and(eq(payoutRuns.periodStart, period.start), eq(payoutRuns.periodEnd, period.end)))
    .limit(1);

  if (existing?.id) return { payoutRunId: existing.id };

  const [created] = await db
    .insert(payoutRuns)
    .values({
      timezone,
      periodStart: period.start,
      periodEnd: period.end,
      scheduledPayoutAt: cutoffAt,
      status: "draft",
      createdBy: input.actorId ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .returning({ id: payoutRuns.id });

  if (!created?.id) throw new Error("payout_run_create_failed");
  return { payoutRunId: created.id };
}

export async function lockPayoutRun(db: DatabaseClient, input: { payoutRunId: string; actorId?: string | null }): Promise<void> {
  const [run] = await db
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, input.payoutRunId))
    .limit(1);

  if (!run) throw new Error("payout_run_not_found");
  if (run.status !== "draft") return;

  await db.transaction(async (tx) => {
    await tx.delete(payoutRunLines).where(eq(payoutRunLines.payoutRunId, input.payoutRunId));

    const commissionRows = await tx
      .select({
        memberId: appointmentCommissions.memberId,
        role: appointmentCommissions.role,
        amountCents: sql<number>`sum(${appointmentCommissions.amountCents})`.mapWith(Number)
      })
      .from(appointmentCommissions)
      .innerJoin(appointments, eq(appointmentCommissions.appointmentId, appointments.id))
      .where(
        and(
          gte(appointments.completedAt, run.periodStart),
          lt(appointments.completedAt, run.periodEnd),
          eq(appointments.status, "completed")
        )
      )
      .groupBy(appointmentCommissions.memberId, appointmentCommissions.role);

    const adjustmentRows = await tx
      .select({
        memberId: payoutRunAdjustments.memberId,
        amountCents: sql<number>`sum(${payoutRunAdjustments.amountCents})`.mapWith(Number)
      })
      .from(payoutRunAdjustments)
      .where(eq(payoutRunAdjustments.payoutRunId, input.payoutRunId))
      .groupBy(payoutRunAdjustments.memberId);

    const adjustmentMap = new Map<string, number>();
    for (const row of adjustmentRows) {
      if (row.memberId) adjustmentMap.set(row.memberId, Number(row.amountCents ?? 0));
    }

    const memberIds = Array.from(
      new Set(commissionRows.map((row) => row.memberId).filter((id): id is string => typeof id === "string"))
    );
    const members = memberIds.length
      ? await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(inArray(teamMembers.id, memberIds))
      : [];
    const memberSet = new Set(members.map((m) => m.id));

    type Totals = { sales: number; marketing: number; crew: number; adjustments: number };
    const totalsByMember = new Map<string, Totals>();
    for (const row of commissionRows) {
      const memberId = row.memberId;
      if (!memberId || !memberSet.has(memberId)) continue;
      const totals = totalsByMember.get(memberId) ?? { sales: 0, marketing: 0, crew: 0, adjustments: 0 };
      const cents = Number(row.amountCents ?? 0);
      if (row.role === "sales") totals.sales += cents;
      if (row.role === "marketing") totals.marketing += cents;
      if (row.role === "crew") totals.crew += cents;
      totalsByMember.set(memberId, totals);
    }

    for (const [memberId, adjustment] of adjustmentMap.entries()) {
      const totals = totalsByMember.get(memberId) ?? { sales: 0, marketing: 0, crew: 0, adjustments: 0 };
      totals.adjustments += adjustment;
      totalsByMember.set(memberId, totals);
    }

    const lines: Array<typeof payoutRunLines.$inferInsert> = [];
    for (const [memberId, totals] of totalsByMember.entries()) {
      const totalCents = totals.sales + totals.marketing + totals.crew + totals.adjustments;
      lines.push({
        payoutRunId: input.payoutRunId,
        memberId,
        salesCents: totals.sales,
        marketingCents: totals.marketing,
        crewCents: totals.crew,
        adjustmentsCents: totals.adjustments,
        totalCents
      });
    }

    if (lines.length > 0) {
      await tx.insert(payoutRunLines).values(lines.map((line) => ({ ...line, createdAt: new Date() })));
    }

    await tx
      .update(payoutRuns)
      .set({
        status: "locked",
        lockedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(payoutRuns.id, input.payoutRunId));
  });
}

export async function markPayoutRunPaid(db: DatabaseClient, payoutRunId: string): Promise<void> {
  await db
    .update(payoutRuns)
    .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
    .where(eq(payoutRuns.id, payoutRunId));
}
