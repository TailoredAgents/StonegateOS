import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  appointmentCommissions,
  appointments,
  getDb,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers,
} from "@/db";
import {
  getOrCreateCommissionSettings,
  recalculateCurrentPayoutPeriodAppointments,
  resolveCurrentPayoutPeriod,
} from "@/lib/commissions";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

type MemberRollup = {
  memberId: string | null;
  memberName: string;
  currentPayrollCents: number;
  currentReimbursementCents: number;
  currentSalesCents: number;
  currentManagementCents: number;
  currentCrewCents: number;
  currentOtherAdjustmentsCents: number;
  monthPayrollCents: number;
  monthReimbursementCents: number;
  yearPayrollCents: number;
  yearReimbursementCents: number;
};

type MonthRollup = {
  month: string;
  label: string;
  payrollCents: number;
  reimbursementCents: number;
};

function memberKey(memberId: string | null, memberName: string | null): string {
  return memberId ?? `unknown:${memberName ?? "team-member"}`;
}

function displayName(memberName: string | null): string {
  return (memberName ?? "Unknown team member").trim() || "Unknown team member";
}

function getMember(
  map: Map<string, MemberRollup>,
  memberId: string | null,
  memberName: string | null,
): MemberRollup {
  const key = memberKey(memberId, memberName);
  const existing = map.get(key);
  if (existing) return existing;

  const created: MemberRollup = {
    memberId,
    memberName: displayName(memberName),
    currentPayrollCents: 0,
    currentReimbursementCents: 0,
    currentSalesCents: 0,
    currentManagementCents: 0,
    currentCrewCents: 0,
    currentOtherAdjustmentsCents: 0,
    monthPayrollCents: 0,
    monthReimbursementCents: 0,
    yearPayrollCents: 0,
    yearReimbursementCents: 0,
  };
  map.set(key, created);
  return created;
}

function cents(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseYear(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2020 || parsed > fallback + 1)
    return fallback;
  return parsed;
}

function parseMonth(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) return fallback;
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const settings = await getOrCreateCommissionSettings(db);
  const now = DateTime.now().setZone(settings.timezone);
  const year = parseYear(request.nextUrl.searchParams.get("year"), now.year);
  const month = parseMonth(
    request.nextUrl.searchParams.get("month"),
    now.month,
  );
  const yearStart = DateTime.fromObject(
    { year, month: 1, day: 1 },
    { zone: settings.timezone },
  ).startOf("day");
  const yearEnd = yearStart.plus({ years: 1 });
  const monthStart = DateTime.fromObject(
    { year, month, day: 1 },
    { zone: settings.timezone },
  ).startOf("day");
  const monthEnd = monthStart.plus({ months: 1 });
  const currentPeriod = resolveCurrentPayoutPeriod(new Date(), settings);

  await recalculateCurrentPayoutPeriodAppointments(db);

  const members = new Map<string, MemberRollup>();
  const monthly = new Map<string, MonthRollup>();
  for (let i = 1; i <= 12; i += 1) {
    const monthDate = DateTime.fromObject(
      { year, month: i, day: 1 },
      { zone: settings.timezone },
    );
    monthly.set(monthDate.toFormat("yyyy-MM"), {
      month: monthDate.toFormat("yyyy-MM"),
      label: monthDate.toFormat("LLL"),
      payrollCents: 0,
      reimbursementCents: 0,
    });
  }

  const historicalRuns = await db
    .select({
      id: payoutRuns.id,
      scheduledPayoutAt: payoutRuns.scheduledPayoutAt,
      status: payoutRuns.status,
    })
    .from(payoutRuns)
    .where(
      and(
        inArray(payoutRuns.status, ["locked", "paid"]),
        gte(payoutRuns.scheduledPayoutAt, yearStart.toJSDate()),
        lt(payoutRuns.scheduledPayoutAt, yearEnd.toJSDate()),
      ),
    )
    .orderBy(asc(payoutRuns.scheduledPayoutAt));
  const historicalRunIds = historicalRuns.map((run) => run.id);
  const historicalRunById = new Map(historicalRuns.map((run) => [run.id, run]));

  const historicalLines = historicalRunIds.length
    ? await db
        .select({
          payoutRunId: payoutRunLines.payoutRunId,
          memberId: payoutRunLines.memberId,
          memberName: teamMembers.name,
          totalCents: payoutRunLines.totalCents,
        })
        .from(payoutRunLines)
        .leftJoin(teamMembers, eq(payoutRunLines.memberId, teamMembers.id))
        .where(inArray(payoutRunLines.payoutRunId, historicalRunIds))
    : [];

  const historicalReimbursements = historicalRunIds.length
    ? await db
        .select({
          payoutRunId: payoutRunAdjustments.payoutRunId,
          memberId: payoutRunAdjustments.memberId,
          memberName: teamMembers.name,
          amountCents: payoutRunAdjustments.amountCents,
        })
        .from(payoutRunAdjustments)
        .leftJoin(
          teamMembers,
          eq(payoutRunAdjustments.memberId, teamMembers.id),
        )
        .where(
          and(
            inArray(payoutRunAdjustments.payoutRunId, historicalRunIds),
            eq(payoutRunAdjustments.kind, "reimbursement"),
          ),
        )
    : [];

  const reimbursementsByRunMember = new Map<string, number>();
  for (const row of historicalReimbursements) {
    const key = `${row.payoutRunId}:${memberKey(row.memberId, row.memberName)}`;
    reimbursementsByRunMember.set(
      key,
      (reimbursementsByRunMember.get(key) ?? 0) + cents(row.amountCents),
    );
  }

  for (const row of historicalLines) {
    const run = historicalRunById.get(row.payoutRunId);
    if (!run) continue;
    const reimbursementKey = `${row.payoutRunId}:${memberKey(row.memberId, row.memberName)}`;
    const reimbursementCents =
      reimbursementsByRunMember.get(reimbursementKey) ?? 0;
    const payrollCents = cents(row.totalCents) - reimbursementCents;
    const member = getMember(members, row.memberId, row.memberName);
    member.yearPayrollCents += payrollCents;
    member.yearReimbursementCents += reimbursementCents;

    const scheduled = DateTime.fromJSDate(run.scheduledPayoutAt).setZone(
      settings.timezone,
    );
    const monthBucket = monthly.get(scheduled.toFormat("yyyy-MM"));
    if (monthBucket) {
      monthBucket.payrollCents += payrollCents;
      monthBucket.reimbursementCents += reimbursementCents;
    }
    if (scheduled >= monthStart && scheduled < monthEnd) {
      member.monthPayrollCents += payrollCents;
      member.monthReimbursementCents += reimbursementCents;
    }
  }

  const currentCommissionRows = await db
    .select({
      memberId: appointmentCommissions.memberId,
      memberName: teamMembers.name,
      role: appointmentCommissions.role,
      amountCents: appointmentCommissions.amountCents,
    })
    .from(appointmentCommissions)
    .innerJoin(
      appointments,
      eq(appointmentCommissions.appointmentId, appointments.id),
    )
    .leftJoin(teamMembers, eq(appointmentCommissions.memberId, teamMembers.id))
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.completedAt, currentPeriod.periodStart),
        lt(appointments.completedAt, currentPeriod.periodEnd),
      ),
    );

  for (const row of currentCommissionRows) {
    const amount = cents(row.amountCents);
    const member = getMember(members, row.memberId, row.memberName);
    member.currentPayrollCents += amount;
    if (row.role === "sales") member.currentSalesCents += amount;
    if (row.role === "marketing") member.currentManagementCents += amount;
    if (row.role === "crew") member.currentCrewCents += amount;
  }

  const [currentRun] = await db
    .select({ id: payoutRuns.id })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.periodStart, currentPeriod.periodStart),
        eq(payoutRuns.periodEnd, currentPeriod.periodEnd),
      ),
    )
    .limit(1);

  if (currentRun?.id) {
    const currentAdjustments = await db
      .select({
        memberId: payoutRunAdjustments.memberId,
        memberName: teamMembers.name,
        kind: payoutRunAdjustments.kind,
        amountCents: payoutRunAdjustments.amountCents,
      })
      .from(payoutRunAdjustments)
      .leftJoin(teamMembers, eq(payoutRunAdjustments.memberId, teamMembers.id))
      .where(eq(payoutRunAdjustments.payoutRunId, currentRun.id));

    for (const row of currentAdjustments) {
      const amount = cents(row.amountCents);
      const member = getMember(members, row.memberId, row.memberName);
      if (row.kind === "reimbursement") {
        member.currentReimbursementCents += amount;
      } else {
        member.currentPayrollCents += amount;
        member.currentOtherAdjustmentsCents += amount;
      }
    }
  }

  const memberRows = Array.from(members.values()).sort((a, b) => {
    const totalA = a.yearPayrollCents + a.currentPayrollCents;
    const totalB = b.yearPayrollCents + b.currentPayrollCents;
    if (totalA !== totalB) return totalB - totalA;
    return a.memberName.localeCompare(b.memberName);
  });
  const monthlyRows = Array.from(monthly.values());
  const totals = memberRows.reduce(
    (sum, member) => ({
      currentPayrollCents: sum.currentPayrollCents + member.currentPayrollCents,
      currentReimbursementCents:
        sum.currentReimbursementCents + member.currentReimbursementCents,
      monthPayrollCents: sum.monthPayrollCents + member.monthPayrollCents,
      monthReimbursementCents:
        sum.monthReimbursementCents + member.monthReimbursementCents,
      yearPayrollCents: sum.yearPayrollCents + member.yearPayrollCents,
      yearReimbursementCents:
        sum.yearReimbursementCents + member.yearReimbursementCents,
    }),
    {
      currentPayrollCents: 0,
      currentReimbursementCents: 0,
      monthPayrollCents: 0,
      monthReimbursementCents: 0,
      yearPayrollCents: 0,
      yearReimbursementCents: 0,
    },
  );

  return NextResponse.json({
    ok: true,
    timezone: settings.timezone,
    year,
    month,
    monthLabel: monthStart.toFormat("LLLL yyyy"),
    currentPeriod: {
      periodStart: currentPeriod.periodStart.toISOString(),
      periodEnd: currentPeriod.periodEnd.toISOString(),
      scheduledPayoutAt: currentPeriod.scheduledPayoutAt.toISOString(),
    },
    totals: {
      ...totals,
      currentTotalPayoutCents:
        totals.currentPayrollCents + totals.currentReimbursementCents,
      monthTotalPayoutCents:
        totals.monthPayrollCents + totals.monthReimbursementCents,
      yearTotalPayoutCents:
        totals.yearPayrollCents + totals.yearReimbursementCents,
    },
    members: memberRows.map((member) => ({
      ...member,
      currentTotalPayoutCents:
        member.currentPayrollCents + member.currentReimbursementCents,
      monthTotalPayoutCents:
        member.monthPayrollCents + member.monthReimbursementCents,
      yearTotalPayoutCents:
        member.yearPayrollCents + member.yearReimbursementCents,
    })),
    monthly: monthlyRows.map((row) => ({
      ...row,
      totalPayoutCents: row.payrollCents + row.reimbursementCents,
    })),
  });
}
