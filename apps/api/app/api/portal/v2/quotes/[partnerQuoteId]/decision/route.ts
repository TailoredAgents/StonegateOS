import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requireRecentPartnerMfaCapability } from "@/lib/partner-recent-mfa";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  portalV2RequestHash,
  runPortalV2IdempotentMutation,
} from "@/lib/partner-portal-v2-idempotency";
import { decideCanonicalPartnerQuote } from "@/lib/partner-portal-v2-quotes";
import { reconcileQuoteAcceptanceCertificate } from "@/lib/quote-v2-acceptance-certificate";
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

const SignerSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    title: z.string().trim().min(2).max(160).optional(),
    company: z.string().trim().min(2).max(200).optional(),
  })
  .strict();

const DecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("accepted"),
      signer: SignerSchema.extend({
        title: z.string().trim().min(2).max(160),
      }),
      authorityAffirmed: z.literal(true),
      consentAffirmed: z.literal(true),
      selectedOptionIds: z
        .array(z.string().trim().min(1).max(80))
        .max(100)
        .refine(
          (values) => new Set(values).size === values.length,
          "Option selections must be unique.",
        )
        .default([]),
      consentVersion: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      decision: z.literal("declined"),
      signer: SignerSchema,
      category: z.enum(["price", "scope", "timing", "competitor", "other"]),
      notes: z.string().trim().max(2_000).optional(),
    })
    .strict(),
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ partnerQuoteId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requireRecentPartnerMfaCapability(
    request,
    "quotes.respond",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { partnerQuoteId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(partnerQuoteId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
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
      maximumBytes: 8_192,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const bounded = error instanceof BoundedJsonRequestError ? error : null;
    return createPartnerPortalV2ErrorResponse(
      bounded?.code === "invalid_body" ? "invalid_body" : "invalid_request",
      bounded?.status ?? 400,
      correlationId,
    );
  }
  const command = DecisionSchema.safeParse(raw);
  if (!command.success) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          decision:
            "Choose accept or decline and complete the required evidence.",
          signer: "Enter the authorized signer's required information.",
        },
      }),
    );
  }
  const ifMatch = request.headers.get("if-match");
  const requestHash = portalV2RequestHash({
    accountId: principal.accountId,
    partnerQuoteId,
    command: command.data,
  });
  try {
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: "partner.quote.decision",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/quotes/${partnerQuoteId}/decision:${principal.accountId}`,
      payload: { command: command.data, ifMatch },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_quote_decision",
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
        return decideCanonicalPartnerQuote({
          principal,
          partnerQuoteId,
          command: command.data,
          idempotencyKeyHash: idempotency.keyHash!,
          requestHash,
          ifMatch,
          correlationId,
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
    let result = run.result;
    const data =
      result.body["ok"] === true &&
      result.body["data"] &&
      typeof result.body["data"] === "object" &&
      !Array.isArray(result.body["data"])
        ? (result.body["data"] as Record<string, unknown>)
        : null;
    if (
      data?.["decision"] === "accepted" &&
      typeof data["responseId"] === "string" &&
      isPortalV2Uuid(data["responseId"])
    ) {
      const certificate = await reconcileQuoteAcceptanceCertificate(getDb(), {
        responseId: data["responseId"],
        correlationId,
      });
      result = {
        ...result,
        body: {
          ...result.body,
          data: { ...data, certificateState: certificate.state },
        },
      };
    }
    return createPartnerPortalV2StoredResponse(result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
