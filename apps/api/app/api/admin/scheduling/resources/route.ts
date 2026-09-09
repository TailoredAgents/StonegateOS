import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  readStaffResourceConfiguration,
  saveStaffResourceConfiguration,
  StaffResourceMutationSchema,
} from "@/lib/staff-scheduling-resources";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { z } from "zod";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, "policy.read");
  if (denied) return denied;
  const result = await readStaffResourceConfiguration();
  return NextResponse.json(
    { ok: true, ...result },
    {
      headers: {
        "Cache-Control": "private, no-store",
        ETag: `"${result.version}"`,
      },
    },
  );
}
export async function POST(request: NextRequest) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["policy.write"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "scheduling.resource_configuration_changed",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation,
    db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const body = StaffResourceMutationSchema.parse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 12000,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/scheduling/resources",
      entityType: "schedule_resource_configuration",
      entityId: "global",
      payload: body,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await saveStaffResourceConfiguration(tx, mutation, body);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "schedule_resource_configuration",
        entityId: data.id,
        metadata: {
          operation: body.operation,
          reason: body.reason,
          acknowledgedImpact: true,
        },
        ...(data.removedRequirement ? { before: data.removedRequirement } : {}),
        committedAt: new Date(data.changedAt),
      });
      const response = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: data.changedAt,
        entityType: "schedule_resource_configuration",
        entityId: data.id,
        version: data.configuration.version,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claim!,
        response,
        200,
        new Date(data.changedAt),
      );
      return response;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
    });
  } catch (caught) {
    const error =
      caught instanceof z.ZodError
        ? new TeamMutationFailure(
            "invalid",
            "Review the resource, skills, and reason fields.",
          )
        : caught;
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(error, mutation);
  }
}
