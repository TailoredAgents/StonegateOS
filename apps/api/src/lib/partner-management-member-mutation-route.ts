import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { mutatePartnerAccountMemberAsStaff } from "@/lib/partner-portal-v2-members";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const RoleInputSchema = z
  .object({
    accountId: z.string().uuid(),
    roleKey: z.enum([
      "administrator",
      "operations",
      "billing_approver",
      "viewer",
    ]),
    confirmation: z.literal("UPDATE MEMBERSHIP ROLE"),
  })
  .strict();

const ScopeInputSchema = z
  .object({
    accountId: z.string().uuid(),
    accessLevel: z.enum(["account", "scoped"]),
    locationIds: z.array(z.string().uuid()).max(250).default([]),
    costCenterIds: z.array(z.string().uuid()).max(250).default([]),
    confirmation: z.literal("UPDATE MEMBERSHIP SCOPE"),
  })
  .strict();

type RouteContext = { params: Promise<{ membershipId?: string }> };

export async function handleStaffPartnerMemberUpdate(input: {
  request: NextRequest;
  context: RouteContext;
  mutation: TeamMutationContext;
  action: "role_update" | "scope_update";
  route: string;
}): Promise<Response> {
  const { membershipId: rawMembershipId } = await input.context.params;
  const membershipId = rawMembershipId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(membershipId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner membership.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: { membershipId: "Refresh Partner administration." },
      },
    );
  }
  if (
    !input.mutation.expectedVersion ||
    input.mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest membership version is required.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: { version: "Refresh the membership before continuing." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(input.request, {
      maximumBytes: 48 * 1_024,
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
      input.mutation,
    );
  }
  const parsed =
    input.action === "role_update"
      ? RoleInputSchema.safeParse(raw)
      : ScopeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      input.action === "role_update"
        ? "Choose a role and confirm the membership change."
        : "Choose an account-owned scope and confirm the membership change.",
      {
        correlationId: input.mutation.correlationId,
        fieldErrors: {
          confirmation:
            input.action === "role_update"
              ? "Enter UPDATE MEMBERSHIP ROLE exactly."
              : "Enter UPDATE MEMBERSHIP SCOPE exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, input.mutation, {
      route: input.route,
      entityType: "partner_account_membership",
      entityId: membershipId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const serviceMutation =
        input.action === "role_update"
          ? {
              action: "role_update" as const,
              roleKey: (parsed.data as z.infer<typeof RoleInputSchema>).roleKey,
            }
          : {
              action: "scope_update" as const,
              accessLevel: (parsed.data as z.infer<typeof ScopeInputSchema>)
                .accessLevel,
              locationIds: (parsed.data as z.infer<typeof ScopeInputSchema>)
                .locationIds,
              costCenterIds: (parsed.data as z.infer<typeof ScopeInputSchema>)
                .costCenterIds,
            };
      const changed = await mutatePartnerAccountMemberAsStaff(tx, {
        partnerAccountId: parsed.data.accountId,
        membershipId,
        mutation: serviceMutation,
        expectedVersion: input.mutation.expectedVersion!,
      });
      const audit = await input.mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_membership",
        entityId: membershipId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: changed.partnerAccountId,
          partnerUserId: changed.partnerUserId,
          scope: "single_partner_account",
        },
      });
      const mutationResult = teamMutationSuccessResult(
        input.mutation,
        {
          membershipId,
          partnerAccountId: changed.partnerAccountId,
          partnerUserId: changed.partnerUserId,
          status: changed.status,
          roleKey: changed.roleKey,
          accessLevel: changed.accessLevel,
          accessScope: changed.accessScope,
          version: changed.version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_membership",
          entityId: membershipId,
          version: changed.version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        input.mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(
      result,
      200,
      input.mutation.correlationId,
      {
        "Cache-Control": "private, no-store",
        ETag: `"${String(result.receipt.version)}"`,
      },
    );
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          input.mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[partner-management] member_update_settlement_failed", {
          correlationId: input.mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, input.mutation);
  }
}
