import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  revokePartnerAccountDomainAsStaff,
  verifyPartnerAccountDomainAsStaff,
} from "@/lib/partner-account-domain-administration";
import { requirePermission } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  recordTeamMutationFailure,
  strengthenTeamMutationPolicy,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VerifyInputSchema = z
  .object({
    accountId: z.string().uuid(),
    verificationMethod: z.enum([
      "dns_txt",
      "email_challenge",
      "manual_document",
    ]),
    verificationEvidence: z.string().trim().min(8).max(2_000),
    overrideConflictingVerification: z.boolean().default(false),
    overrideReason: z.string().trim().min(12).max(1_000).optional(),
    confirmation: z.enum(["VERIFY COMPANY DOMAIN", "TRANSFER VERIFIED DOMAIN"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.overrideConflictingVerification
      ? "TRANSFER VERIFIED DOMAIN"
      : "VERIFY COMPANY DOMAIN";
    if (value.confirmation !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expected} exactly.`,
      });
    }
    if (value.overrideConflictingVerification && !value.overrideReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overrideReason"],
        message: "Explain why the verified tenant boundary should move.",
      });
    }
  });
const RevokeInputSchema = z
  .object({
    accountId: z.string().uuid(),
    reason: z.string().trim().min(12).max(1_000),
    confirmation: z.literal("REVOKE COMPANY DOMAIN"),
  })
  .strict();

type RouteContext = { params: Promise<{ domainId?: string }> };

export async function handleStaffPartnerAccountDomainLifecycle(input: {
  request: NextRequest;
  context: RouteContext;
  mutation: TeamMutationContext;
  action: "verify" | "revoke";
}): Promise<Response> {
  let mutation = input.mutation;
  const { domainId: rawDomainId } = await input.context.params;
  const domainId = rawDomainId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(domainId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid account domain.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { domainId: "Refresh Partner administration." },
      },
    );
  }
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest domain version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the domain before continuing." },
      },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(input.request, {
      maximumBytes: 6 * 1_024,
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
  const parsed =
    input.action === "verify"
      ? VerifyInputSchema.safeParse(raw)
      : RevokeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      input.action === "verify"
        ? "Provide verification provenance and the exact confirmation."
        : "Provide a revocation reason and the exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          confirmation: "Use the confirmation shown for this action.",
        },
      },
    );
  }
  const accountId = parsed.data.accountId;
  const verifyInput =
    input.action === "verify"
      ? (parsed.data as z.infer<typeof VerifyInputSchema>)
      : null;
  if (verifyInput?.overrideConflictingVerification) {
    const overrideError = await requirePermission(
      input.request,
      "partners.domains.override",
    );
    if (overrideError) {
      await recordTeamMutationFailure(mutation, {
        outcome: "denied",
        entityType: "partner_account_domain",
        entityId: domainId,
        code: "forbidden",
        metadata: {
          phase: "conflicting_domain_override_permission",
          partnerAccountId: accountId,
          additionalRequiredPermission: "partners.domains.override",
        },
      });
      return teamMutationErrorResponse(
        "forbidden",
        "Only a Team Owner can transfer a verified domain between accounts.",
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
      route: `PATCH /api/admin/partner-management/v1/domains/:domainId/${input.action}`,
      entityType: "partner_account_domain",
      entityId: domainId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changed = verifyInput
        ? await verifyPartnerAccountDomainAsStaff(tx, {
            partnerAccountId: accountId,
            domainId,
            verificationMethod: verifyInput.verificationMethod,
            verificationEvidence: verifyInput.verificationEvidence,
            verifiedByTeamMemberId: mutation.actor.id!,
            expectedVersion: mutation.expectedVersion!,
            allowConflictingVerificationOverride:
              verifyInput.overrideConflictingVerification,
          })
        : await revokePartnerAccountDomainAsStaff(tx, {
            partnerAccountId: accountId,
            domainId,
            revokedByTeamMemberId: mutation.actor.id!,
            expectedVersion: mutation.expectedVersion!,
          });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_domain",
        entityId: domainId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: changed.partnerAccountId,
          normalizedDomain: changed.normalizedDomain,
          verificationEvidencePresent: Boolean(verifyInput),
          reasonPresent: Boolean(
            verifyInput?.overrideReason ??
              (parsed.data as z.infer<typeof RevokeInputSchema>).reason,
          ),
          conflictingDomainsRevoked: changed.conflictingDomainsRevoked,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          domainId,
          partnerAccountId: changed.partnerAccountId,
          normalizedDomain: changed.normalizedDomain,
          status: changed.status,
          verificationMethod: changed.verificationMethod,
          verifiedAt: changed.verifiedAt,
          revokedAt: changed.revokedAt,
          conflictingDomainsRevoked: changed.conflictingDomainsRevoked.length,
          version: changed.version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_domain",
          entityId: domainId,
          version: changed.version,
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
      "Cache-Control": "private, no-store",
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[partner-management] domain_lifecycle_settlement_failed",
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
