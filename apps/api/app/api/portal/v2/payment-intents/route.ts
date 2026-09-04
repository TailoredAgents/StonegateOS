import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  arePartnerPortalEmbeddedAchPaymentsEnabled,
  arePartnerPortalEmbeddedPaymentsEnabled,
} from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import {
  createPartnerEmbeddedPaymentIntent,
  PartnerPaymentIntentRequestSchema,
} from "@/lib/partner-portal-v2-payments";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
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

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (
    !isSecurePartnerPaymentRequest(request) ||
    !isAllowedPartnerPortalMutationOrigin(request)
  ) {
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
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "account_access_required",
      403,
      correlationId,
    );
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
  const payload = PartnerPaymentIntentRequestSchema.safeParse(raw);
  if (!payload.success) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          invoiceId: "Choose an invoice from this account.",
          purpose: "Choose deposit or one_off.",
          paymentMethod: "Choose card or ACH for secure portal checkout.",
          amount: "Provide a positive USD amount in integer minor units.",
        },
      }),
    );
  }
  if (payload.data.paymentMethod === "ach") {
    if (!arePartnerPortalEmbeddedAchPaymentsEnabled(principal.accountId)) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("invalid_fields", correlationId, {
          fieldErrors: {
            paymentMethod:
              "ACH bank transfer is not enabled for this account. Choose card or contact Stonegate.",
          },
        }),
      );
    }
  }

  try {
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: "partner.payment.embedded_checkout.prepare",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/payment-intents:${principal.accountId}`,
      payload: payload.data,
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_payment_checkout",
          request,
          identity: {
            kind: "partner_user",
            value: principal.partnerUserId,
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
        return createPartnerEmbeddedPaymentIntent({
          accountId: principal.accountId!,
          membershipId: principal.membershipId!,
          partnerUserId: principal.partnerUserId,
          email: principal.email,
          roleKey: principal.roleKey,
          sessionId: principal.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
          invoiceId: payload.data.invoiceId,
          purpose: payload.data.purpose,
          amountMinor: payload.data.amount.amountMinor,
          currency: payload.data.amount.currency,
          paymentMethod: payload.data.paymentMethod,
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
