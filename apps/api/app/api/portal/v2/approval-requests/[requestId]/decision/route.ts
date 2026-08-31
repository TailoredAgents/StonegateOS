import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { decidePartnerApprovalRequest } from "@/lib/partner-portal-v2-approvals";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
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

const DecisionSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    reason: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "declined" && (value.reason?.length ?? 0) < 5) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A decline reason of at least five characters is required.",
      });
    }
  })
  .transform((value) => ({
    decision: value.decision,
    reason: value.reason?.trim() || null,
  }));

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "bookings.approve",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (principal.session.assuranceLevel !== "aal2") {
    return createPartnerPortalV2ErrorResponse(
      "mfa_step_up_required",
      403,
      correlationId,
    );
  }
  const { requestId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(requestId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
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
      maximumBytes: 2_048,
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
  const payload = DecisionSchema.safeParse(raw);
  if (!payload.success) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_fields", correlationId, {
        fieldErrors: {
          decision: "Choose approved or declined.",
          reason: "Declines require a reason of 5–1,000 characters.",
        },
      }),
    );
  }
  const ifMatch = request.headers.get("if-match");
  try {
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: "partner.approval.decide",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/approval-requests/${requestId}/decision:${principal.accountId}`,
      payload: { ...payload.data, ifMatch },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_approval_decision",
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
        return decidePartnerApprovalRequest({
          accountId: principal.accountId!,
          membershipId: principal.membershipId!,
          partnerUserId: principal.partnerUserId,
          email: principal.email,
          roleKey: principal.roleKey,
          sessionId: principal.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
          requestId,
          ifMatch,
          decision: payload.data.decision,
          reason: payload.data.reason,
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
