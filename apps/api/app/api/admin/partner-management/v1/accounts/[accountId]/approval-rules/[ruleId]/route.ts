import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  PARTNER_APPROVAL_RULE_UUID_PATTERN,
  UpdatePartnerApprovalRuleSchema,
} from "@/lib/partner-approval-rule-administration-route";
import {
  getPartnerApprovalRuleForStaff,
  updatePartnerApprovalRuleAsStaff,
} from "@/lib/partner-approval-rule-administration";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { requirePermission } from "@/lib/permissions";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;
type RouteContext = {
  params: Promise<{ accountId?: string; ruleId?: string }>;
};

function identifiers(input: {
  accountId?: string;
  ruleId?: string;
}): { accountId: string; ruleId: string } | null {
  const accountId = input.accountId?.trim().toLowerCase() ?? "";
  const ruleId = input.ruleId?.trim().toLowerCase() ?? "";
  return PARTNER_APPROVAL_RULE_UUID_PATTERN.test(accountId) &&
    PARTNER_APPROVAL_RULE_UUID_PATTERN.test(ruleId)
    ? { accountId, ruleId }
    : null;
}

function notFound(correlationId?: string): Response {
  return teamMutationErrorResponse(
    "invalid",
    "The approval-rule resource was not found.",
    { status: 404, ...(correlationId ? { correlationId } : {}) },
  );
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.commercial.read",
  );
  if (permissionError) return permissionError;
  const ids = identifiers(await context.params);
  if (!ids) return notFound();
  try {
    const rule = await getPartnerApprovalRuleForStaff({
      partnerAccountId: ids.accountId,
      ruleId: ids.ruleId,
    });
    if (!rule) return notFound();
    return NextResponse.json(
      { ok: true, partnerAccountId: ids.accountId, rule },
      { headers: { ...NO_STORE_HEADERS, ETag: rule.etag } },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.commercial.manage"],
    risk: "financial",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_approval_rule.updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const ids = identifiers(await context.params);
  if (!ids) return notFound(mutation.correlationId);
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest approval-rule revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the approval rule before saving." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
  const parsed = UpdatePartnerApprovalRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded canonical approval rule, reason, and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          rule: "Check the name, conditions, decision count, and active state.",
          confirmation: "Enter UPDATE APPROVAL RULE exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "PATCH /api/admin/partner-management/v1/accounts/:accountId/approval-rules/:ruleId",
      entityType: "partner_approval_rule",
      entityId: ids.ruleId,
      payload: { partnerAccountId: ids.accountId, ...parsed.data },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changed = await updatePartnerApprovalRuleAsStaff(tx, {
        partnerAccountId: ids.accountId,
        ruleId: ids.ruleId,
        values: parsed.data,
        expectedVersion: mutation.expectedVersion!,
        teamMemberId: mutation.actor.id!,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_approval_rule",
        entityId: changed.rule.id,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: ids.accountId,
          active: changed.rule.active,
          requiredDecisionCount: changed.rule.requiredDecisionCount,
          approverCapabilities: ["approvals.decide"],
          deactivated:
            changed.before["active"] === true && !changed.rule.active,
          reactivated:
            changed.before["active"] === false && changed.rule.active,
          reason: parsed.data.reason,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { partnerAccountId: ids.accountId, rule: changed.rule },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_approval_rule",
          entityId: changed.rule.id,
          version: String(changed.rule.revision),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      ...NO_STORE_HEADERS,
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[partner-management] approval_rule_update_settlement_failed",
          {
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
