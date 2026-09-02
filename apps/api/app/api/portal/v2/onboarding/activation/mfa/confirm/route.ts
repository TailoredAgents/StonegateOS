import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { completePartnerActivationMfa } from "@/lib/partner-activation-mfa-auth";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const ConfirmSchema = z
  .object({
    challengeId: z.string().uuid().optional(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u)
      .optional(),
    recoveryCode: z.string().trim().min(8).max(64).optional(),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.code) === Boolean(value.recoveryCode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one verification method.",
      });
    }
    if (value.challengeId && !value.code) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Authenticator enrollment requires a code.",
      });
    }
  });

function bearerToken(request: NextRequest): string {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : "";
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const token = bearerToken(request);
  if (!token) {
    return createPartnerPortalV2ErrorResponse(
      "unauthorized",
      401,
      correlationId,
    );
  }
  try {
    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: 2_048,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        "invalid_body",
        failure?.status ?? 400,
        correlationId,
      );
    }
    const parsed = ConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const fingerprint = createHash("sha256")
      .update(token, "utf8")
      .digest("hex");
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_activation",
      request,
      identity: { kind: "token", value: fingerprint },
    });
    if (rateLimit.limited) {
      const response = createPartnerPortalV2ErrorResponse(
        "rate_limited",
        429,
        correlationId,
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const result = await completePartnerActivationMfa({
      transactionToken: token,
      request,
      correlationId,
      ...parsed.data,
    });
    if (result.kind === "invalid_transaction") {
      return createPartnerPortalV2ErrorResponse(
        "unauthorized",
        401,
        correlationId,
      );
    }
    if (result.kind === "expired") {
      return createPartnerPortalV2ErrorResponse(
        "session_expired",
        410,
        correlationId,
      );
    }
    if (result.kind === "enrollment_required") {
      return createPartnerPortalV2ErrorResponse(
        "mfa_enrollment_required",
        409,
        correlationId,
      );
    }
    if (result.kind === "invalid_code") {
      return createPartnerPortalV2SuccessResponse(
        {
          ok: false,
          error: "invalid_mfa_code",
          attemptsRemaining: result.attemptsRemaining,
        },
        correlationId,
        422,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        status: "authenticated",
        assuranceLevel: "aal2",
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollment: {
          enrolled: result.enrolled,
          recoveryCodes: result.recoveryCodes,
          displayOnce: result.recoveryCodes.length > 0,
        },
        recoveryCodeUsed: result.recoveryCodeUsed,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
