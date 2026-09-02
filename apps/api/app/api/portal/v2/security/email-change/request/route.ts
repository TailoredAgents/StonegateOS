import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { requestPartnerEmailChange } from "@/lib/partner-email-change";
import { PARTNER_PASSWORD_MAX_LENGTH } from "@/lib/partner-password-management";
import {
  arePartnerPortalV2WritesEnabled,
  arePartnerPurposeAuthTokensEnabled,
} from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const EmailChangeRequestSchema = z
  .object({
    newEmail: z.string().trim().email().max(254),
    currentPassword: z
      .string()
      .min(1)
      .max(PARTNER_PASSWORD_MAX_LENGTH)
      .optional(),
  })
  .strict();

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "portal.session.read",
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
  if (
    !arePartnerPurposeAuthTokensEnabled() ||
    !arePartnerPortalV2WritesEnabled(principal.accountId)
  ) {
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

  try {
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
        maximumBytes: 1_024,
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
    const parsed = EmailChangeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_email_change_request",
      request,
      identity: { kind: "partner_user", value: principal.partnerUserId },
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

    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}`,
      action: "partner.auth.email_change.request",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/security/email-change/request",
      payload: {
        newEmail: parsed.data.newEmail.toLowerCase(),
        currentPasswordProvided: Boolean(parsed.data.currentPassword),
      },
      correlationId,
      execute: async () => {
        const result = await requestPartnerEmailChange({
          actor: {
            partnerUserId: principal.partnerUserId,
            email: principal.email,
            roleKey: principal.roleKey,
            accountId: principal.accountId!,
            membershipId: principal.membershipId!,
            sessionId: principal.session.id,
            mfaRequired: principal.security.mfaRequired,
            correlationId,
          },
          newEmail: parsed.data.newEmail,
          currentPassword: parsed.data.currentPassword,
          request,
        });
        if (result.kind === "accepted") {
          return {
            status: 202,
            body: {
              ok: true,
              message:
                "If that address is eligible, a 30-minute confirmation link will be sent.",
            },
          };
        }
        if (result.kind === "same_email") {
          return {
            status: 422,
            body: {
              ok: false,
              error: "invalid_fields",
              message: "Choose a different sign-in email.",
              fieldErrors: { newEmail: "This is already your sign-in email." },
            },
          };
        }
        if (
          result.kind === "current_password_required" ||
          result.kind === "invalid_current_password"
        ) {
          return {
            status: 422,
            body: {
              ok: false,
              error: "invalid_fields",
              message: "Confirm your current password to change your email.",
              fieldErrors: {
                currentPassword:
                  result.kind === "current_password_required"
                    ? "Enter your current password."
                    : "The current password is incorrect.",
              },
            },
          };
        }
        if (
          result.kind === "recent_mfa_required" ||
          result.kind === "recent_authentication_required"
        ) {
          return {
            status: 403,
            body: {
              ok: false,
              error: "mfa_step_up_required",
              message:
                result.kind === "recent_mfa_required"
                  ? "Verify this session with two-step verification before changing your email."
                  : "Sign in again before changing your email.",
              alternatives: [
                {
                  action:
                    result.kind === "recent_mfa_required"
                      ? "verify_mfa"
                      : "reauthenticate",
                  label:
                    result.kind === "recent_mfa_required"
                      ? "Verify this session"
                      : "Sign in again",
                  href:
                    result.kind === "recent_mfa_required"
                      ? "/partners/settings#two-step-verification"
                      : "/partners/login?returnTo=%2Fpartners%2Fsettings",
                },
              ],
            },
          };
        }
        return {
          status: 401,
          body: {
            ok: false,
            error:
              result.kind === "session_unavailable"
                ? "session_revoked"
                : "unauthorized",
            message: "Sign in again before changing your email.",
          },
        };
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        run.reason === "different_request"
          ? "idempotency_conflict"
          : "conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
