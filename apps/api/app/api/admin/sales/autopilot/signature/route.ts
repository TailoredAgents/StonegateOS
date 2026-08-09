import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";

const POLICY_KEY = "sales_autopilot";
const ABSENT_POLICY_VERSION = "absent";
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidVersionResponse(message: string): Response {
  return NextResponse.json(
    {
      ok: false,
      code: "invalid",
      message,
      retryable: false,
      fieldErrors: { version: "Use the version loaded with this card." },
    } satisfies MutationResult<never>,
    { status: 422 },
  );
}

export async function PATCH(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["policy.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sales.autopilot.signature.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const expectedVersion = mutation.expectedVersion;

  if (expectedVersion === null || expectedVersion === "*") {
    return invalidVersionResponse(
      "The current Sales agent signature version is required. Refresh and try again.",
    );
  }
  if (expectedVersion !== ABSENT_POLICY_VERSION) {
    const parsedVersion = new Date(expectedVersion);
    if (
      Number.isNaN(parsedVersion.getTime()) ||
      parsedVersion.toISOString() !== expectedVersion
    ) {
      return invalidVersionResponse(
        "The Sales agent signature version is malformed. Refresh and try again.",
      );
    }
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "The Sales agent signature payload is invalid.",
        retryable: false,
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }
  if (
    Object.keys(payload).some((key) => key !== "agentDisplayName") ||
    typeof payload["agentDisplayName"] !== "string" ||
    payload["agentDisplayName"].trim().length < 1 ||
    payload["agentDisplayName"].trim().length > 80
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "Use a Sales agent name from 1 to 80 characters.",
        retryable: false,
        fieldErrors: {
          agentDisplayName: "Use a name from 1 to 80 characters.",
        },
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }
  const agentDisplayName = payload["agentDisplayName"].trim();
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/sales/autopilot/signature",
      entityType: "policy_setting",
      entityId: POLICY_KEY,
      payload: { agentDisplayName },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('team_policy:sales_autopilot'))`,
      );
      const [existing] = await tx
        .select({
          value: policySettings.value,
          updatedAt: policySettings.updatedAt,
        })
        .from(policySettings)
        .where(eq(policySettings.key, POLICY_KEY))
        .for("update")
        .limit(1);

      const actualVersion = existing?.updatedAt.toISOString() ?? null;
      const expectedAbsent = expectedVersion === ABSENT_POLICY_VERSION;
      if (
        (expectedAbsent && existing) ||
        (!expectedAbsent && actualVersion !== expectedVersion)
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "Another teammate saved Sales Autopilot settings after you loaded this card. Your input was not applied.",
          {
            fieldErrors: {
              version: "Refresh, review the newer settings, and retry.",
            },
          },
        );
      }

      const now = new Date(
        Math.max(Date.now(), (existing?.updatedAt.getTime() ?? -1) + 1),
      );
      const mergedValue = {
        ...(isRecord(existing?.value) ? existing.value : {}),
        agentDisplayName,
      };
      const [saved] = existing
        ? await tx
            .update(policySettings)
            .set({
              value: mergedValue,
              updatedBy: mutation.actor.id,
              updatedAt: now,
            })
            .where(eq(policySettings.key, POLICY_KEY))
            .returning({
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            })
        : await tx
            .insert(policySettings)
            .values({
              key: POLICY_KEY,
              value: mergedValue,
              updatedBy: mutation.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning({
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            });
      if (!saved) {
        throw new TeamMutationFailure(
          "internal",
          "The Sales agent signature change could not be confirmed.",
          { retryable: true },
        );
      }

      const auditReceipt = await mutation.audit.insertSuccess(tx, {
        entityType: "policy_setting",
        entityId: POLICY_KEY,
        before: existing
          ? { version: actualVersion }
          : { version: ABSENT_POLICY_VERSION },
        after: { version: saved.updatedAt.toISOString() },
        metadata: { changedFields: ["agentDisplayName"] },
        committedAt: now,
      });
      const version = saved.updatedAt.toISOString();
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          key: "sales_autopilot_signature",
          agentDisplayName,
          version,
          updatedAt: version,
          updatedBy: saved.updatedBy,
        },
        {
          auditEventId: auditReceipt.auditEventId,
          committedAt: auditReceipt.committedAt,
          entityType: "policy_setting",
          entityId: POLICY_KEY,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        now,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[sales-autopilot-signature] idempotency_settlement_failed",
          {
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
