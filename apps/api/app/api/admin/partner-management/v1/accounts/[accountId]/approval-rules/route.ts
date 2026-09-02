import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  CreatePartnerApprovalRuleSchema,
  parseIncludeInactive,
  PARTNER_APPROVAL_RULE_UUID_PATTERN,
} from "@/lib/partner-approval-rule-administration-route";
import {
  createPartnerApprovalRuleAsStaff,
  isStaffPartnerApprovalRuleCursorPayload,
  listPartnerApprovalRulesForStaff,
  listPartnerApprovalRuleOptionsForStaff,
  PARTNER_APPROVAL_RULE_CURSOR_KIND,
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
import { parsePortalV2Pagination } from "@/lib/portal-v2-contract";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;
type RouteContext = { params: Promise<{ accountId?: string }> };

function accountIdFrom(raw: string | undefined): string | null {
  const accountId = raw?.trim().toLowerCase() ?? "";
  return PARTNER_APPROVAL_RULE_UUID_PATTERN.test(accountId) ? accountId : null;
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
  const accountId = accountIdFrom((await context.params).accountId);
  if (!accountId) {
    return teamMutationErrorResponse(
      "invalid",
      "The approval-rule resource was not found.",
      { status: 404 },
    );
  }
  const includeInactive = parseIncludeInactive(request.nextUrl.searchParams);
  if (!includeInactive.ok) {
    return teamMutationErrorResponse("invalid", includeInactive.message, {
      fieldErrors: { includeInactive: includeInactive.message },
    });
  }
  const pagination = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: PARTNER_APPROVAL_RULE_CURSOR_KIND,
    validateCursorPayload: isStaffPartnerApprovalRuleCursorPayload,
    defaultLimit: 50,
    maximumLimit: 100,
    allowedQueryKeys: new Set(["includeInactive"]),
  });
  if (!pagination.ok) {
    return teamMutationErrorResponse(
      "invalid",
      "The list request is invalid.",
      {
        fieldErrors: pagination.fieldErrors,
      },
    );
  }
  try {
    const [result, options] = await Promise.all([
      listPartnerApprovalRulesForStaff({
        partnerAccountId: accountId,
        includeInactive: includeInactive.value,
        limit: pagination.limit,
        cursor: pagination.cursor,
      }),
      listPartnerApprovalRuleOptionsForStaff({ partnerAccountId: accountId }),
    ]);
    if (!result) {
      return teamMutationErrorResponse(
        "invalid",
        "The approval-rule resource was not found.",
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: true, partnerAccountId: accountId, ...result, options },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.commercial.manage"],
    risk: "financial",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_approval_rule.created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const accountId = accountIdFrom((await context.params).accountId);
  if (!accountId) {
    return teamMutationErrorResponse(
      "invalid",
      "The approval-rule resource was not found.",
      { status: 404, correlationId: mutation.correlationId },
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
  const parsed = CreatePartnerApprovalRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded canonical approval rule, reason, and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          rule: "Check the name, conditions, decision count, and active state.",
          confirmation: "Enter CREATE APPROVAL RULE exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/accounts/:accountId/approval-rules",
      entityType: "partner_approval_rule_account",
      entityId: accountId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const created = await createPartnerApprovalRuleAsStaff(tx, {
        partnerAccountId: accountId,
        values: parsed.data,
        teamMemberId: mutation.actor.id!,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_approval_rule",
        entityId: created.rule.id,
        before: null,
        after: created.after,
        metadata: {
          partnerAccountId: accountId,
          active: created.rule.active,
          requiredDecisionCount: created.rule.requiredDecisionCount,
          approverCapabilities: ["approvals.decide"],
          reason: parsed.data.reason,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { partnerAccountId: accountId, rule: created.rule },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_approval_rule",
          entityId: created.rule.id,
          version: String(created.rule.revision),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 201, mutation.correlationId, {
      ...NO_STORE_HEADERS,
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[partner-management] approval_rule_create_settlement_failed",
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
