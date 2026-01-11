import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { lockPayoutRun } from "@/lib/commissions";
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
  const actor = getAuditActorFromRequest(request);
  await lockPayoutRun(db, { payoutRunId, actorId: actor.id ?? null });

  await recordAuditEvent({
    actor,
    action: "commission.payout_run.locked",
    entityType: "payout_run",
    entityId: payoutRunId,
    meta: null
  });

  return NextResponse.json({ ok: true, payoutRunId });
}

