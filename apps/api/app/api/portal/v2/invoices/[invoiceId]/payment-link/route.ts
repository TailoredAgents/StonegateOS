import type { NextRequest } from "next/server";
import { requirePartnerCapability, type PartnerPrincipal } from "@/lib/partner-account-authorization";
import { arePartnerPortalHostedPaymentsEnabled } from "@/lib/partner-portal-feature-flags";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import { getPartnerInvoiceHostedPaymentLink } from "@/lib/partner-portal-v2-payments";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin, isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

async function authorizeInvoicePaymentRequest(
  request: NextRequest,
  invoiceId: string,
  correlationId: string,
): Promise<PartnerPrincipal | Response> {
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
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(invoiceId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!arePartnerPortalHostedPaymentsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  return principal;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const { invoiceId } = await context.params;
  const authorization = await authorizeInvoicePaymentRequest(
    request,
    invoiceId,
    correlationId,
  );
  if (authorization instanceof Response) return authorization;
  if (request.nextUrl.search.length > 0) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_request",
      400,
      correlationId,
    );
  }
  try {
    const result = await getPartnerInvoiceHostedPaymentLink({
      accountId: authorization.accountId!,
      invoiceId,
    });
    if (!result.ok) {
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        eligible: result.eligible,
        paymentIntent: result.paymentLink,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}


/** Read-only compatibility for links already issued; no new hosted collection. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const { invoiceId } = await context.params;
  const authorization = await authorizeInvoicePaymentRequest(request, invoiceId, correlationId);
  if (authorization instanceof Response) return authorization;
  return createPartnerPortalV2ErrorResponse("payment_channel_retired", 410, correlationId);
}
