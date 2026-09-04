import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPartnerAccountInvitation,
  listPartnerAccountInvitations,
  PartnerInvitationCreateSchema,
} from "@/lib/partner-account-invitations";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "account.members.manage",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const keys = [...request.nextUrl.searchParams.keys()];
  const rawLimit = request.nextUrl.searchParams.get("limit") ?? "50";
  if (
    keys.some((key) => key !== "limit") ||
    request.nextUrl.searchParams.getAll("limit").length > 1
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_request",
      400,
      correlationId,
    );
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  try {
    const invitations = await listPartnerAccountInvitations({
      principal,
      limit,
    });
    return createPartnerPortalV2SuccessResponse(
      { ok: true, invitations },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] invitation list failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "account.members.manage",
    );
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    const { principal } = authorization;
    if (!principal.accountId || !principal.membershipId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    if (principal.accessLevel !== "account") {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    if (request.nextUrl.search.length > 0) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_request",
        400,
        correlationId,
      );
    }
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    }
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
        maximumBytes: 16_384,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        failure?.code === "invalid_body" ? "invalid_body" : "invalid_request",
        failure?.status ?? 400,
        correlationId,
      );
    }
    const payload = PartnerInvitationCreateSchema.safeParse(raw);
    if (!payload.success) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("invalid_fields", correlationId, {
          fieldErrors: {
            email: "Enter a valid work email address.",
            name: "Enter the teammate’s full name.",
            roleKey: "Choose an available role.",
            persona: "Choose the teammate’s partner type.",
            accessLevel: "Choose account-wide or scoped access.",
            locationIds: "Choose valid active locations for this account.",
            costCenterIds: "Choose valid active cost centers for this account.",
          },
        }),
      );
    }
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: "partner.account_invitation.create",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/invitations:${principal.accountId}`,
      payload: payload.data,
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_invitation_management",
          request,
          identity: { kind: "partner_user", value: principal.partnerUserId },
        });
        if (rateLimit.limited) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
          };
        }
        return createPartnerAccountInvitation({
          principal,
          payload: payload.data,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
        });
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(
          run.reason === "different_request"
            ? "idempotency_conflict"
            : "conflict",
          correlationId,
        ),
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    console.error("[partner-portal-v2] invitation create failed", {
      correlationId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
