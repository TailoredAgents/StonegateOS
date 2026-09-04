import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalEmbeddedPaymentsEnabled } from "@/lib/partner-portal-feature-flags";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import { getPartnerPaymentIntent } from "@/lib/partner-portal-v2-payments";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ paymentIntentId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isSecurePartnerPaymentRequest(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "payments.initiate",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { paymentIntentId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(paymentIntentId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!arePartnerPortalEmbeddedPaymentsEnabled(principal.accountId)) {
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
  try {
    const result = await getPartnerPaymentIntent({
      accountId: principal.accountId,
      paymentIntentId,
    });
    if (!result.ok) {
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, paymentIntent: result.paymentIntent },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
