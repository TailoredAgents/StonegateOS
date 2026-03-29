import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  expenses,
  getDb,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers,
} from "@/db";
import { getAuditActorFromRequest } from "@/lib/audit";
import { calculatePayoutRunLiveTotalCents } from "@/lib/payout-run-report";
import { requirePermission } from "@/lib/permissions";
import { createOrGetCurrentPayoutRun } from "@/lib/commissions";
import { isAdminRequest } from "../../../web/admin";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const { searchParams } = request.nextUrl;
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw
    ? Math.min(Math.max(Number(limitRaw) || 10, 1), 50)
    : 10;

  const runs = await db
    .select({
      id: payoutRuns.id,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd,
      scheduledPayoutAt: payoutRuns.scheduledPayoutAt,
      status: payoutRuns.status,
      createdAt: payoutRuns.createdAt,
      lockedAt: payoutRuns.lockedAt,
      paidAt: payoutRuns.paidAt,
    })
    .from(payoutRuns)
    .orderBy(desc(payoutRuns.createdAt))
    .limit(limit);
  const runIds = runs.map((run) => run.id);

  const totals = await db
    .select({
      payoutRunId: payoutRunLines.payoutRunId,
      totalCents: sql<number>`sum(${payoutRunLines.totalCents})`.mapWith(
        Number,
      ),
    })
    .from(payoutRunLines)
    .groupBy(payoutRunLines.payoutRunId);

  const adjustments = runIds.length
    ? await db
        .select({
          payoutRunId: payoutRunAdjustments.payoutRunId,
          id: payoutRunAdjustments.id,
          memberId: payoutRunAdjustments.memberId,
          memberName: teamMembers.name,
          kind: payoutRunAdjustments.kind,
          amountCents: payoutRunAdjustments.amountCents,
          note: payoutRunAdjustments.note,
          createdAt: payoutRunAdjustments.createdAt,
          expenseId: expenses.id,
          expensePaidAt: expenses.paidAt,
          expenseCategory: expenses.category,
          expenseVendor: expenses.vendor,
          expenseMemo: expenses.memo,
          expenseReceiptFilename: expenses.receiptFilename,
          expenseReceiptContentType: expenses.receiptContentType,
        })
        .from(payoutRunAdjustments)
        .leftJoin(
          teamMembers,
          eq(payoutRunAdjustments.memberId, teamMembers.id),
        )
        .leftJoin(expenses, eq(payoutRunAdjustments.expenseId, expenses.id))
        .where(inArray(payoutRunAdjustments.payoutRunId, runIds))
        .orderBy(desc(payoutRunAdjustments.createdAt))
    : [];

  const totalsMap = new Map<string, number>();
  for (const row of totals) {
    totalsMap.set(row.payoutRunId, Number(row.totalCents ?? 0));
  }

  const adjustmentsByRun = new Map<
    string,
    Array<{
      id: string;
      memberId: string | null;
      memberName: string | null;
      kind: string;
      amountCents: number;
      note: string | null;
      createdAt: string;
      expense:
        | {
            id: string;
            paidAt: string;
            category: string | null;
            vendor: string | null;
            memo: string | null;
            receipt: { filename: string; contentType: string } | null;
          }
        | null;
    }>
  >();

  for (const row of adjustments) {
    const existing = adjustmentsByRun.get(row.payoutRunId) ?? [];
    existing.push({
      id: row.id,
      memberId: row.memberId,
      memberName: row.memberName,
      kind: row.kind,
      amountCents: Number(row.amountCents ?? 0),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      expense: row.expenseId
        ? {
            id: row.expenseId,
            paidAt: row.expensePaidAt?.toISOString() ?? row.createdAt.toISOString(),
            category: row.expenseCategory,
            vendor: row.expenseVendor,
            memo: row.expenseMemo,
            receipt: row.expenseReceiptFilename
              ? {
                  filename: row.expenseReceiptFilename,
                  contentType:
                    row.expenseReceiptContentType ?? "application/octet-stream",
                }
              : null,
          }
        : null,
    });
    adjustmentsByRun.set(row.payoutRunId, existing);
  }

  const payoutRunsPayload = await Promise.all(
    runs.map(async (run) => {
      const runAdjustments = adjustmentsByRun.get(run.id) ?? [];
      const reimbursementTotalCents = runAdjustments.reduce(
        (sum, adjustment) =>
          adjustment.kind === "reimbursement"
            ? sum + adjustment.amountCents
            : sum,
        0,
      );
      const otherAdjustmentsTotalCents = runAdjustments.reduce(
        (sum, adjustment) =>
          adjustment.kind === "reimbursement"
            ? sum
            : sum + adjustment.amountCents,
        0,
      );
      const totalCents =
        run.status === "draft"
          ? await calculatePayoutRunLiveTotalCents(db, {
              id: run.id,
              periodStart: run.periodStart,
              periodEnd: run.periodEnd,
            })
          : (totalsMap.get(run.id) ?? 0);

      return {
        id: run.id,
        timezone: run.timezone,
        periodStart: run.periodStart.toISOString(),
        periodEnd: run.periodEnd.toISOString(),
        scheduledPayoutAt: run.scheduledPayoutAt.toISOString(),
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        lockedAt: run.lockedAt ? run.lockedAt.toISOString() : null,
        paidAt: run.paidAt ? run.paidAt.toISOString() : null,
        totalCents,
        reimbursementTotalCents,
        otherAdjustmentsTotalCents,
        adjustments: runAdjustments,
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    payoutRuns: payoutRunsPayload,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const { payoutRunId } = await createOrGetCurrentPayoutRun(db, {
    actorId: actor.id ?? null,
  });
  return NextResponse.json({ ok: true, payoutRunId });
}
