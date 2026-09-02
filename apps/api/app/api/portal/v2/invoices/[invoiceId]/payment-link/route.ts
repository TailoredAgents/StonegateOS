import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  requirePartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { requireRecentPartnerMfaCapability } from "@/lib/partner-recent-mfa";
import { arePartnerPortalHostedPaymentsEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import {
  createPartnerHostedPaymentIntent,
  getPartnerInvoiceHostedPaymentLink,
  PartnerInvoicePaymentLinkRequestSchema,
} from "@/lib/partner-portal-v2-payments";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";

async function authorizeInvoicePaymentRequest(
  request: NextRequest,
  invoiceId: string,
  correlationId: string,
  recentMfaRequired: boolean,
): Promise<PartnerPrincipal | Response> {
  if (!isSecurePartnerPaymentRequest(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = recentMfaRequired
    ? await requireRecentPartnerMfaCapability(request, "payments.initiate")
    : await requirePartnerCapability(request, "payments.initiate");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!recentMfaRequired && principal.session.assuranceLevel !== "aal2") {
    return createPartnerPortalV2ErrorResponse(
      "mfa_step_up_required",
      403,
      correlationId,
    );
  }
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
    false,
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const { invoiceId } = await context.params;
  const authorization = await authorizeInvoicePaymentRequest(
    request,
    invoiceId,
    correlationId,
    true,
  );
  if (authorization instanceof Response) return authorization;
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
      maximumBytes: 4_096,
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
  const payload = PartnerInvoicePaymentLinkRequestSchema.safeParse(raw);
  if (!payload.success) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          purpose: "Choose deposit or one_off.",
          paymentMethod: "Only card is available for hosted checkout.",
          amount: "Provide a positive USD amount in integer minor units.",
        },
      }),
    );
  }
  if (payload.data.paymentMethod === "ach") {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          paymentMethod: "ACH is unavailable for hosted checkout. Choose card.",
        },
      }),
    );
  }

  try {
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${authorization.partnerUserId}:membership:${authorization.membershipId}`,
      action: "partner.invoice.hosted_payment_link.create",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/invoices/${invoiceId}/payment-link:${authorization.accountId}`,
      payload: payload.data,
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_payment_checkout",
          request,
          identity: {
            kind: "partner_user",
            value: authorization.partnerUserId,
          },
        });
        if (rateLimit.limited) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: {
              "Retry-After": String(rateLimit.retryAfterSeconds),
            },
          };
        }
        return createPartnerHostedPaymentIntent({
          accountId: authorization.accountId!,
          membershipId: authorization.membershipId!,
          partnerUserId: authorization.partnerUserId,
          email: authorization.email,
          roleKey: authorization.roleKey,
          sessionId: authorization.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
          invoiceId,
          purpose: payload.data.purpose,
          amountMinor: payload.data.amount.amountMinor,
          currency: payload.data.amount.currency,
          paymentMethod: "card",
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
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
