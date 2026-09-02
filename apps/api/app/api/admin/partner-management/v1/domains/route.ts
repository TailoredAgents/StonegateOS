import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { createPartnerAccountDomainAsStaff } from "@/lib/partner-account-domain-administration";
import { partnerManagementListResponse } from "@/lib/partner-management-route";
import { requirePermission } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  strengthenTeamMutationPolicy,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const InputSchema = z
  .object({
    accountId: z.string().uuid(),
    domain: z.string().trim().min(3).max(253),
    restoreRevoked: z.boolean().default(false),
    reason: z.string().trim().min(12).max(1_000).optional(),
    confirmation: z.enum(["ADD COMPANY DOMAIN", "RESTORE REVOKED DOMAIN"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.restoreRevoked
      ? "RESTORE REVOKED DOMAIN"
      : "ADD COMPANY DOMAIN";
    if (value.confirmation !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expected} exactly.`,
      });
    }
    if (value.restoreRevoked && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Explain why the revoked domain should be restored.",
      });
    }
  });

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.domains.read",
  );
  if (permissionError) return permissionError;
  return partnerManagementListResponse(
    request,
    "domains",
    "partners.domains.read",
    true,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.domains.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account_domain.created",
  });
  if (!boundary.ok) return boundary.response;
  let mutation = boundary.mutation;
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest account or domain version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh Partner administration." },
      },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1_024,
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
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide the account, company domain, and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { domain: "Enter a company-owned domain." },
      },
    );
  }
  const input = parsed.data;
  if (input.restoreRevoked) {
    const overrideError = await requirePermission(
      request,
      "partners.domains.override",
    );
    if (overrideError) {
      await recordTeamMutationFailure(mutation, {
        outcome: "denied",
        entityType: "partner_account_domain",
        code: "forbidden",
        metadata: {
          phase: "restore_permission",
          partnerAccountId: input.accountId,
          additionalRequiredPermission: "partners.domains.override",
        },
      });
      return teamMutationErrorResponse(
        "forbidden",
        "Only a Team Owner can restore a revoked company domain.",
        { correlationId: mutation.correlationId },
      );
    }
    mutation = strengthenTeamMutationPolicy(mutation, [
      "partners.domains.override",
    ]);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/partner-management/v1/domains",
      entityType: "partner_account_domain",
      entityId: `${input.accountId}:${input.domain.toLowerCase()}`,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changed = await createPartnerAccountDomainAsStaff(tx, {
        partnerAccountId: input.accountId,
        rawDomain: input.domain,
        expectedVersion: mutation.expectedVersion!,
        allowRestore: input.restoreRevoked,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_domain",
        entityId: changed.domainId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: changed.partnerAccountId,
          normalizedDomain: changed.normalizedDomain,
          restored: changed.previousVersion !== null,
          overrideReasonPresent: Boolean(input.reason),
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          domainId: changed.domainId,
          partnerAccountId: changed.partnerAccountId,
          normalizedDomain: changed.normalizedDomain,
          status: changed.status,
          version: changed.version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_domain",
          entityId: changed.domainId,
          version: changed.version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        changed.previousVersion === null ? 201 : 200,
      );
      return {
        mutationResult,
        status: changed.previousVersion === null ? 201 : 200,
      };
    });
    return teamMutationResultResponse(
      result.mutationResult,
      result.status,
      mutation.correlationId,
      {
        "Cache-Control": "private, no-store",
        ETag: `"${String(result.mutationResult.receipt.version)}"`,
      },
    );
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partner-management] domain_create_settlement_failed", {
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
