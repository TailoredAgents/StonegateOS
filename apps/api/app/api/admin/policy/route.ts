import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import {
  DEFAULT_BUSINESS_HOURS_POLICY,
  DEFAULT_BOOKING_RULES_POLICY,
  DEFAULT_COMPANY_PROFILE_POLICY,
  DEFAULT_CONVERSATION_PERSONA_POLICY,
  DEFAULT_CONFIRMATION_LOOP_POLICY,
  DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
  DEFAULT_INBOX_ALERTS_POLICY,
  DEFAULT_QUIET_HOURS_POLICY,
  DEFAULT_REVIEW_REQUEST_POLICY,
  DEFAULT_SERVICE_AREA_POLICY,
  DEFAULT_ITEM_POLICIES,
  DEFAULT_STANDARD_JOB_POLICY,
  DEFAULT_TEMPLATES_POLICY,
} from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import {
  EDITABLE_POLICY_KEYS,
  isEditablePolicyKey,
  validatePolicyValue,
  type EditablePolicyKey,
} from "@/lib/policy-input";
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

const POLICY_KEYS = EDITABLE_POLICY_KEYS;
const ABSENT_POLICY_VERSION = "absent";

const DEFAULT_POLICY_VALUES: Record<
  EditablePolicyKey,
  Record<string, unknown>
> = {
  business_hours: DEFAULT_BUSINESS_HOURS_POLICY,
  quiet_hours: DEFAULT_QUIET_HOURS_POLICY,
  service_area: DEFAULT_SERVICE_AREA_POLICY,
  company_profile: DEFAULT_COMPANY_PROFILE_POLICY,
  conversation_persona: DEFAULT_CONVERSATION_PERSONA_POLICY,
  inbox_alerts: DEFAULT_INBOX_ALERTS_POLICY,
  booking_rules: DEFAULT_BOOKING_RULES_POLICY,
  confirmation_loop: DEFAULT_CONFIRMATION_LOOP_POLICY,
  follow_up_sequence: DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
  standard_job: DEFAULT_STANDARD_JOB_POLICY,
  item_policies: DEFAULT_ITEM_POLICIES,
  review_request: DEFAULT_REVIEW_REQUEST_POLICY,
  templates: DEFAULT_TEMPLATES_POLICY,
};

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const keys = POLICY_KEYS;

  const rows = await db
    .select({
      key: policySettings.key,
      value: policySettings.value,
      updatedAt: policySettings.updatedAt,
      updatedBy: policySettings.updatedBy,
    })
    .from(policySettings)
    .where(inArray(policySettings.key, keys));

  const rowMap = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    rowMap.set(row.key, row);
  }

  const settings = keys.map((key) => {
    const row = rowMap.get(key);
    return {
      key,
      value: row?.value ?? DEFAULT_POLICY_VALUES[key],
      version: row?.updatedAt
        ? row.updatedAt.toISOString()
        : ABSENT_POLICY_VERSION,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  });

  return NextResponse.json({ settings });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["policy.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "policy.update",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message:
          "The current policy version is required. Refresh the Policy Center and try again.",
        retryable: false,
        fieldErrors: { version: "Use the version loaded with this card." },
      } satisfies MutationResult<never>,
      { status: 422 },
    );
  }
  if (mutation.expectedVersion !== ABSENT_POLICY_VERSION) {
    const parsedVersion = new Date(mutation.expectedVersion);
    if (
      Number.isNaN(parsedVersion.getTime()) ||
      parsedVersion.toISOString() !== mutation.expectedVersion
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid",
          message:
            "The policy version is malformed. Refresh the Policy Center and try again.",
          retryable: false,
          fieldErrors: {
            version: "Use the exact version loaded with this card.",
          },
        } satisfies MutationResult<never>,
        { status: 422 },
      );
    }
  }

  const payload = (await request.json().catch(() => null)) as {
    key?: string;
    value?: unknown;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (typeof payload.key !== "string" || !isEditablePolicyKey(payload.key)) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }

  const policyKey = payload.key;
  const validation = validatePolicyValue(policyKey, payload.value);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: "invalid_policy_value",
        message: validation.message,
        fieldErrors: validation.fieldErrors,
      },
      { status: 422 },
    );
  }

  const expectedVersion = mutation.expectedVersion;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/policy",
      entityType: "policy_setting",
      entityId: policyKey,
      payload: { key: policyKey, value: validation.value },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // A row lock cannot protect the first write when the key is still using
      // its default. Serialize that absent-row transition with the same
      // transaction so two first saves cannot both pass the version check.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`team_policy:${policyKey}`}))`,
      );
      const [existing] = await tx
        .select({
          updatedAt: policySettings.updatedAt,
        })
        .from(policySettings)
        .where(eq(policySettings.key, policyKey))
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
          "Another teammate saved this policy after you loaded it. Your input was not applied.",
          {
            fieldErrors: {
              version: "Refresh this card, review the newer values, and retry.",
            },
          },
        );
      }

      const now = new Date(
        Math.max(Date.now(), (existing?.updatedAt.getTime() ?? -1) + 1),
      );
      const [saved] = existing
        ? await tx
            .update(policySettings)
            .set({
              value: validation.value,
              updatedBy: mutation.actor.id,
              updatedAt: now,
            })
            .where(eq(policySettings.key, policyKey))
            .returning({
              key: policySettings.key,
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            })
        : await tx
            .insert(policySettings)
            .values({
              key: policyKey,
              value: validation.value,
              updatedBy: mutation.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning({
              key: policySettings.key,
              updatedAt: policySettings.updatedAt,
              updatedBy: policySettings.updatedBy,
            });

      if (!saved) {
        throw new TeamMutationFailure(
          "internal",
          "The policy change could not be confirmed.",
          { retryable: true },
        );
      }

      const auditReceipt = await mutation.audit.insertSuccess(tx, {
        entityType: "policy_setting",
        entityId: policyKey,
        before: existing
          ? { version: actualVersion }
          : { version: ABSENT_POLICY_VERSION },
        after: { version: saved.updatedAt.toISOString() },
        metadata: { key: policyKey },
        committedAt: now,
      });

      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          key: saved.key,
          version: saved.updatedAt.toISOString(),
          updatedAt: saved.updatedAt.toISOString(),
          updatedBy: saved.updatedBy,
        },
        {
          auditEventId: auditReceipt.auditEventId,
          committedAt: auditReceipt.committedAt,
          entityType: "policy_setting",
          entityId: policyKey,
          version: saved.updatedAt.toISOString(),
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
        console.error("[policy] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
