import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, teamCallOperationTaskIntents, teamCallOperations } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ operationId?: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "calls.place");
  if (permissionError) return permissionError;

  const operationId = (await context.params).operationId?.trim() ?? "";
  if (!UUID_PATTERN.test(operationId)) {
    return NextResponse.json(
      { error: "invalid_call_operation_id" },
      { status: 422 },
    );
  }

  const db = getDb();
  const [operation] = await db
    .select({
      id: teamCallOperations.id,
      contactId: teamCallOperations.contactId,
      agentMemberId: teamCallOperations.agentMemberId,
      taskId: teamCallOperations.taskId,
      state: teamCallOperations.state,
      version: teamCallOperations.version,
      terminalOutcome: teamCallOperations.terminalOutcome,
      outcomeReason: teamCallOperations.outcomeReason,
      providerOperationPresent: sql<boolean>`${teamCallOperations.providerOperationId} IS NOT NULL`,
      customerOperationPresent: sql<boolean>`${teamCallOperations.providerCustomerOperationId} IS NOT NULL`,
      requestedAt: teamCallOperations.requestedAt,
      dispatchedAt: teamCallOperations.dispatchedAt,
      providerAcceptedAt: teamCallOperations.providerAcceptedAt,
      agentAnsweredAt: teamCallOperations.agentAnsweredAt,
      customerAnsweredAt: teamCallOperations.customerAnsweredAt,
      agentCompletedAt: teamCallOperations.agentCompletedAt,
      customerCompletedAt: teamCallOperations.customerCompletedAt,
      callbackDeadlineAt: teamCallOperations.callbackDeadlineAt,
      guardReleasedAt: teamCallOperations.guardReleasedAt,
      completedAt: teamCallOperations.completedAt,
      reconciliationRequiredAt: teamCallOperations.reconciliationRequiredAt,
      completedExplicitTaskId: teamCallOperations.completedExplicitTaskId,
      completedFollowupTaskId: teamCallOperations.completedFollowupTaskId,
      completedSpeedToLeadCount: teamCallOperations.completedSpeedToLeadCount,
    })
    .from(teamCallOperations)
    .where(eq(teamCallOperations.id, operationId))
    .limit(1);
  if (!operation) {
    return NextResponse.json(
      { error: "call_operation_not_found" },
      { status: 404 },
    );
  }

  const taskEffects = await db
    .select({
      effect: teamCallOperationTaskIntents.effect,
      count: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(teamCallOperationTaskIntents)
    .where(eq(teamCallOperationTaskIntents.callOperationId, operation.id))
    .groupBy(teamCallOperationTaskIntents.effect);

  return NextResponse.json(
    {
      ok: true,
      operation: {
        ...operation,
        contactCallBlocked: operation.guardReleasedAt === null,
        taskEffects: Object.fromEntries(
          taskEffects.map((item) => [item.effect, item.count]),
        ),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
