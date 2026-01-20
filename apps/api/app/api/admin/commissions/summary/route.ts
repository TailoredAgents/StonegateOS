import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { appointmentCommissions, appointments, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  defaultPayPeriodForCutoff,
  getOrCreateCommissionSettings,
  resolveUpcomingPayoutCutoff
} from "@/lib/commissions";
import { isAdminRequest } from "../../../web/admin";

function extractPgCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if ("cause" in error && (error as { cause?: unknown }).cause && typeof (error as { cause?: unknown }).cause === "object") {
    const cause = (error as { cause: { code?: unknown } }).cause;
    if (typeof cause.code === "string") return cause.code;
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  try {
    const settings = await getOrCreateCommissionSettings(db);
    const { cutoffAt, timezone } = resolveUpcomingPayoutCutoff(new Date(), settings);
    const period = defaultPayPeriodForCutoff(cutoffAt, timezone);

    const rows = await db
      .select({
        role: appointmentCommissions.role,
        totalCents: sql<number>`coalesce(sum(${appointmentCommissions.amountCents}), 0)::int`.as("total_cents")
      })
      .from(appointmentCommissions)
      .innerJoin(appointments, eq(appointmentCommissions.appointmentId, appointments.id))
      .where(
        and(
          eq(appointments.status, "completed"),
          gte(appointments.completedAt, period.start),
          lt(appointments.completedAt, period.end)
        )
      )
      .groupBy(appointmentCommissions.role);

    const totals = { sales: 0, marketing: 0, crew: 0, adjustments: 0 };
    for (const row of rows) {
      const cents = Number(row.totalCents ?? 0);
      if (row.role === "sales") totals.sales += cents;
      else if (row.role === "marketing") totals.marketing += cents;
      else if (row.role === "crew") totals.crew += cents;
      else if (row.role === "adjustments") totals.adjustments += cents;
    }

    return NextResponse.json({
      ok: true,
      timezone,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      scheduledPayoutAt: cutoffAt.toISOString(),
      totalsCents: {
        sales: totals.sales,
        marketing: totals.marketing,
        crew: totals.crew,
        adjustments: totals.adjustments,
        total: totals.sales + totals.marketing + totals.crew + totals.adjustments
      }
    });
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    throw error;
  }
}
