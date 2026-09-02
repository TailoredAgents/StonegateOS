import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  PartnerAccountServiceAgreementMutationSchema,
} from "@/lib/partner-account-service-agreement";
import {
  loadPartnerAccountServiceAgreementForStaff,
  updatePartnerAccountServiceAgreementAsStaff,
} from "@/lib/partner-account-service-agreement-administration";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
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
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MutationEnvelopeSchema = z.object({
  reason: z.string().trim().min(12).max(1_000),
  confirmation: z.literal("UPDATE SERVICE AGREEMENT"),
}).passthrough();
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;
type RouteContext = { params: Promise<{ accountId?: string }> };

function accountIdFrom(context: RouteContext): Promise<string> {
  return context.params.then(
    (params) => params.accountId?.trim().toLowerCase() ?? "",
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
  const accountId = await accountIdFrom(context);
  if (!UUID_PATTERN.test(accountId)) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const result = await getDb().transaction((tx) =>
      loadPartnerAccountServiceAgreementForStaff(tx, {
        partnerAccountId: accountId,
      }),
    );
    if (!result) {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        account: result.account,
        agreement: result.agreement,
        serviceOptions: result.serviceOptions,
        servicesTruncated: result.servicesTruncated,
      },
      { headers: { ...NO_STORE_HEADERS, ETag: result.etag } },
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
    risk: "external",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account.service_agreement_updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const accountId = await accountIdFrom(context);
  if (!UUID_PATTERN.test(accountId)) {
    return teamMutationErrorResponse("invalid", "Choose a valid Partner account.", {
      status: 404,
      correlationId: mutation.correlationId,
    });
  }
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest agreement revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the agreement before saving." },
      },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 64 * 1_024,
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
  const envelope = MutationEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded service agreement and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          agreement: "Review dates, currency, service entitlements, and terms.",
          confirmation: "Enter UPDATE SERVICE AGREEMENT exactly.",
        },
      },
    );
  }
  const {
    reason,
    confirmation: _confirmation,
    ...rawAgreement
  } = envelope.data;
  const parsedAgreement = PartnerAccountServiceAgreementMutationSchema.safeParse(
    rawAgreement,
  );
  if (!parsedAgreement.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded service agreement and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          agreement: "Review dates, currency, service entitlements, and terms.",
        },
      },
    );
  }
  const values = parsedAgreement.data;
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "PATCH /api/admin/partner-management/v1/accounts/:accountId/service-agreement",
      entityType: "partner_account_service_agreement",
      entityId: accountId,
      payload: { ...values, reason, confirmation: _confirmation },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const changed = await updatePartnerAccountServiceAgreementAsStaff(tx, {
        partnerAccountId: accountId,
        values,
        expectedVersion: mutation.expectedVersion!,
        changedByTeamMemberId: mutation.actor.id!,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_service_agreement",
        entityId: accountId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: accountId,
          reason,
          entitlementCount: values.services.length,
        },
      });
      const agreement = changed.agreement;
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          partnerAccountId: accountId,
          revision: agreement.revision,
          updatedAt: agreement.updatedAt.toISOString(),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_service_agreement",
          entityId: accountId,
          version: String(agreement.revision),
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
      await settleTeamMutationIdempotencyFailure(db, mutation, claim, error).catch(
        () => undefined,
      );
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
