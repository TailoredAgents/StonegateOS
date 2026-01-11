import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { markPayoutRunPaid } from "@/lib/commissions";
import { isAdminRequest } from "../../../../../web/admin";

export async function POST(
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
  await markPayoutRunPaid(db, payoutRunId);

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "commission.payout_run.paid",
    entityType: "payout_run",
    entityId: payoutRunId,
    meta: null
  });

  return NextResponse.json({ ok: true, payoutRunId });
}

