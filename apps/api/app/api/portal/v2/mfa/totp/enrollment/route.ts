import type { NextRequest } from "next/server";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import { startPartnerTotpEnrollment } from "@/lib/partner-mfa-service";
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

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const result = await resolvePartnerPrincipal(request);
  if (!result.ok) {
    return createPartnerPortalV2ErrorResponse(
      result.error,
      result.status,
      correlationId,
    );
  }
  const { principal } = result;
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
  if (
    principal.security.mfaEnrolled &&
    principal.session.assuranceLevel !== "aal2"
  ) {
    return createPartnerPortalV2ErrorResponse(
      "mfa_step_up_required",
      403,
      correlationId,
    );
  }
  const rateLimit = await consumeTeamAuthRateLimit({
    action: "partner_mfa_enrollment",
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
  try {
    const enrollment = await startPartnerTotpEnrollment({
      actor: {
        partnerUserId: principal.partnerUserId,
        email: principal.email,
        roleKey: principal.roleKey,
        sessionId: principal.session.id,
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        correlationId,
      },
    });
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        enrollment: {
          challengeId: enrollment.challengeId,
          secret: enrollment.secret,
          otpauthUri: enrollment.otpauthUri,
          expiresAt: enrollment.expiresAt.toISOString(),
        },
      },
      correlationId,
      201,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
