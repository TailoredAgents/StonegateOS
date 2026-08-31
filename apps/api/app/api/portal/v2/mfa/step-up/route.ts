import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import { stepUpPartnerMfa } from "@/lib/partner-mfa-service";
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

const StepUpSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u)
      .optional(),
    recoveryCode: z
      .string()
      .trim()
      .regex(/^(?:[A-Z2-7]{4}-){3}[A-Z2-7]{4}$/iu)
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode));

export async function POST(request: NextRequest): Promise<Response> {
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
  if (!principal.accountId) {
    return createPartnerPortalV2ErrorResponse(
      "account_access_required",
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
  const parsed = StepUpSchema.safeParse(body);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  try {
    const stepUp = await stepUpPartnerMfa({
      actor: {
        partnerUserId: principal.partnerUserId,
        email: principal.email,
        roleKey: principal.roleKey,
        sessionId: principal.session.id,
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        correlationId,
      },
      code: parsed.data.code,
      recoveryCode: parsed.data.recoveryCode,
    });
    if (stepUp.kind !== "success") {
      if (stepUp.kind === "not_enrolled") {
        return createPartnerPortalV2ErrorResponse(
          "conflict",
          409,
          correlationId,
        );
      }
      if (stepUp.kind === "invalid_code") {
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
        session: {
          assuranceLevel: "aal2",
          verifiedAt: stepUp.verifiedAt.toISOString(),
          recoveryCodeUsed: stepUp.recoveryCodeUsed,
        },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
