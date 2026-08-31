import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import { confirmPartnerTotpEnrollment } from "@/lib/partner-mfa-service";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ConfirmSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ challengeId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const principalResult = await resolvePartnerPrincipal(request);
  if (!principalResult.ok) {
    return createPartnerPortalV2ErrorResponse(
      principalResult.error,
      principalResult.status,
      correlationId,
    );
  }
  const { principal } = principalResult;
  const { challengeId } = await context.params;
  if (!principal.accountId || !UUID_PATTERN.test(challengeId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const rateLimit = await consumeTeamAuthRateLimit({
    action: "partner_mfa_verification",
    request,
    identity: { kind: "partner_user", value: principal.partnerUserId },
  });
  if (rateLimit.limited) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("rate_limited", correlationId, {
        additionalHeaders: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      }),
    );
  }
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = ConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  try {
    const confirmation = await confirmPartnerTotpEnrollment({
      actor: {
        partnerUserId: principal.partnerUserId,
        email: principal.email,
        roleKey: principal.roleKey,
        sessionId: principal.session.id,
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        correlationId,
      },
      challengeId,
      code: parsed.data.code,
      label: parsed.data.label,
    });
    if (confirmation.kind !== "success") {
      if (confirmation.kind === "not_found") {
        return createPartnerPortalV2ErrorResponse(
          "not_found",
          404,
          correlationId,
        );
      }
      if (confirmation.kind === "expired") {
        return createPartnerPortalV2ErrorResponse(
          "conflict",
          409,
          correlationId,
        );
      }
      if (confirmation.kind === "invalid_code") {
        return createPartnerPortalV2ErrorResponse(
          "invalid_fields",
          422,
          correlationId,
        );
      }
      return createPartnerPortalV2ErrorResponse(
        "session_revoked",
        401,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        enrollment: {
          methodId: confirmation.methodId,
          verifiedAt: confirmation.verifiedAt.toISOString(),
          recoveryCodes: confirmation.recoveryCodes,
          displayOnce: true,
        },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
