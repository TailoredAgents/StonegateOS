import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers,
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function fmtMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    return NextResponse.json({ error: "missing_payout_run_id" }, { status: 400 });
  }

  const db = getDb();
  const [run] = await db
    .select({
      id: payoutRuns.id,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd,
      status: payoutRuns.status
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, payoutRunId))
    .limit(1);

  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const lines = await db
    .select({
      memberId: payoutRunLines.memberId,
      salesCents: payoutRunLines.salesCents,
      marketingCents: payoutRunLines.marketingCents,
      crewCents: payoutRunLines.crewCents,
      adjustmentsCents: payoutRunLines.adjustmentsCents,
      totalCents: payoutRunLines.totalCents,
      memberName: teamMembers.name
    })
    .from(payoutRunLines)
    .leftJoin(teamMembers, eq(payoutRunLines.memberId, teamMembers.id))
    .where(eq(payoutRunLines.payoutRunId, payoutRunId));

  const adjustmentBreakdown = await db
    .select({
      memberId: payoutRunAdjustments.memberId,
      reimbursementCents:
        sql<number>`sum(case when ${payoutRunAdjustments.kind} = 'reimbursement' then ${payoutRunAdjustments.amountCents} else 0 end)`.mapWith(
          Number,
        ),
    })
    .from(payoutRunAdjustments)
    .where(eq(payoutRunAdjustments.payoutRunId, payoutRunId))
    .groupBy(payoutRunAdjustments.memberId);

  const reimbursementByMemberId = new Map<string, number>();
  for (const row of adjustmentBreakdown) {
    if (row.memberId) {
      reimbursementByMemberId.set(
        row.memberId,
        Number(row.reimbursementCents ?? 0),
      );
    }
  }

  const header = [
    "Member",
    "Sales",
    "Management",
    "Crew",
    "Reimbursements",
    "Other Adjustments",
    "Total",
    "Period Start",
    "Period End",
    "Timezone",
    "Status"
  ].join(",");

  const rows = lines
    .sort((a, b) => (a.memberName ?? "").localeCompare(b.memberName ?? ""))
    .map((line) => {
      const member = line.memberName ?? line.memberId ?? "Unknown";
      const reimbursementCents = line.memberId
        ? reimbursementByMemberId.get(line.memberId) ?? 0
        : 0;
      const otherAdjustmentsCents = line.adjustmentsCents - reimbursementCents;
      return [
        csvEscape(member),
        fmtMoney(line.salesCents),
        fmtMoney(line.marketingCents),
        fmtMoney(line.crewCents),
        fmtMoney(reimbursementCents),
        fmtMoney(otherAdjustmentsCents),
        fmtMoney(line.totalCents),
        run.periodStart.toISOString(),
        run.periodEnd.toISOString(),
        csvEscape(run.timezone),
        csvEscape(run.status)
      ].join(",");
    });

  const csv = [header, ...rows].join("\n");
  const filename = `payout-run-${run.periodStart.toISOString().slice(0, 10)}-to-${run.periodEnd
    .toISOString()
    .slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
}
