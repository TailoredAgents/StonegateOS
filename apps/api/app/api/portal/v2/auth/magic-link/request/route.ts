import { NextRequest } from "next/server";
import { POST as requestLegacyPartnerLoginLink } from "../../../../../public/partners/request-link/route";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { normalizeEmail } from "@/lib/partner-portal-auth";
import {
  createPortalV2IdempotencyErrorResponse,
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";

function isExactEmailPayload(value: unknown): value is { email: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)["email"] === "string"
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("forbidden", correlationId),
    );
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  try {
    const legacyRequest = new NextRequest(request.clone());
    let payload: unknown;
    try {
      payload = await readBoundedJsonRequest(request, {
        maximumBytes: 1_024,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(
          failure?.code === "invalid_body" ? "invalid_body" : "invalid_request",
          correlationId,
          { status: failure?.status ?? 400 },
        ),
      );
    }
    const email = isExactEmailPayload(payload)
      ? normalizeEmail(payload.email)
      : null;
    if (!email || email.length > 254 || !email.includes("@")) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("invalid_fields", correlationId, {
          fieldErrors: { email: "Enter a valid email address." },
        }),
      );
    }
    const run = await runPortalV2IdempotentMutation({
      principal: `public-email:${email}`,
      action: "partner.magic_link.request",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/auth/magic-link/request",
      payload: { email },
      correlationId,
      execute: async () => {
        const legacy = await requestLegacyPartnerLoginLink(legacyRequest);
        const retryAfter = legacy.headers.get("retry-after");
        if (legacy.status === 429) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
          };
        }
        if (legacy.status >= 500) {
          return {
            status: 503,
            body: { ok: false, error: "service_unavailable" },
            ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
          };
        }
        return {
          status: 202,
          body: {
            ok: true,
            message:
              "If the account is eligible, a 30-minute sign-in link will be sent.",
          },
        };
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
