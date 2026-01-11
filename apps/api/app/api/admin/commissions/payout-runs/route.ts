import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, payoutRunLines, payoutRuns } from "@/db";
import { getAuditActorFromRequest } from "@/lib/audit";
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
  const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 10, 1), 50) : 10;

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
      paidAt: payoutRuns.paidAt
    })
    .from(payoutRuns)
    .orderBy(desc(payoutRuns.createdAt))
    .limit(limit);

  const totals = await db
    .select({
      payoutRunId: payoutRunLines.payoutRunId,
      totalCents: sql<number>`sum(${payoutRunLines.totalCents})`.mapWith(Number)
    })
    .from(payoutRunLines)
    .groupBy(payoutRunLines.payoutRunId);

  const totalsMap = new Map<string, number>();
  for (const row of totals) {
    totalsMap.set(row.payoutRunId, Number(row.totalCents ?? 0));
  }

  return NextResponse.json({
    ok: true,
    payoutRuns: runs.map((run) => ({
      id: run.id,
      timezone: run.timezone,
      periodStart: run.periodStart.toISOString(),
      periodEnd: run.periodEnd.toISOString(),
      scheduledPayoutAt: run.scheduledPayoutAt.toISOString(),
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      lockedAt: run.lockedAt ? run.lockedAt.toISOString() : null,
      paidAt: run.paidAt ? run.paidAt.toISOString() : null,
      totalCents: totalsMap.get(run.id) ?? 0
    }))
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
  const { payoutRunId } = await createOrGetCurrentPayoutRun(db, { actorId: actor.id ?? null });
  return NextResponse.json({ ok: true, payoutRunId });
}

