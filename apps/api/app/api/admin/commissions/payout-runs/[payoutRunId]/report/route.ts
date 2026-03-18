import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getPayoutRunReportHtml } from "@/lib/payout-run-report";
import { isAdminRequest } from "../../../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    return NextResponse.json(
      { error: "missing_payout_run_id" },
      { status: 400 },
    );
  }

  const db = getDb();

  try {
    const { html, report } = await getPayoutRunReportHtml(db, payoutRunId);
    const filename = `payout-run-${report.run.periodStart.toISOString().slice(0, 10)}-to-${report.run.periodEnd
      .toISOString()
      .slice(0, 10)}.html`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch (error) {
    if ((error as Error).message === "payout_run_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
}
