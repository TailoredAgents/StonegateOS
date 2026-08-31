import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalEmbeddedPaymentsEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import {
  completePartnerEmbeddedPaymentIntent,
  PartnerEmbeddedPaymentCompletionSchema,
} from "@/lib/partner-portal-v2-payments";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
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

function tokenFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentIntentId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (
    !isSecurePartnerPaymentRequest(request) ||
    !isAllowedPartnerPortalMutationOrigin(request)
  ) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "payments.manage",
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
  if (principal.session.assuranceLevel !== "aal2") {
    return createPartnerPortalV2ErrorResponse(
      "mfa_step_up_required",
      403,
      correlationId,
    );
  }
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
  const payload = PartnerEmbeddedPaymentCompletionSchema.safeParse(raw);
  if (!payload.success) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          sourceToken:
            "The secure Square card token is missing or invalid. Re-enter the card details.",
        },
      }),
    );
  }

  try {
    const sourceTokenHash = tokenFingerprint(payload.data.sourceToken);
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: "partner.payment.embedded_checkout.complete",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/payment-intents/${paymentIntentId}/complete:${principal.accountId}`,
      // The one-use token is deliberately excluded from the idempotency row.
      // Its fingerprint still prevents a key from being replayed with a
      // different token without persisting provider credentials.
      payload: { paymentIntentId, sourceTokenHash },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_payment_checkout",
          request,
          identity: { kind: "partner_user", value: principal.partnerUserId },
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
        return completePartnerEmbeddedPaymentIntent({
          accountId: principal.accountId!,
          membershipId: principal.membershipId!,
          partnerUserId: principal.partnerUserId,
          email: principal.email,
          roleKey: principal.roleKey,
          sessionId: principal.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
          paymentIntentId,
          sourceToken: payload.data.sourceToken,
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
