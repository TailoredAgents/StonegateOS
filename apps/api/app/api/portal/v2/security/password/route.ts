import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  changePartnerPassword,
  PARTNER_PASSWORD_MAX_LENGTH,
  PARTNER_PASSWORD_MIN_LENGTH,
} from "@/lib/partner-password-management";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const PasswordChangeSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .max(PARTNER_PASSWORD_MAX_LENGTH)
      .optional(),
    newPassword: z
      .string()
      .min(PARTNER_PASSWORD_MIN_LENGTH)
      .max(PARTNER_PASSWORD_MAX_LENGTH),
    confirmPassword: z
      .string()
      .min(PARTNER_PASSWORD_MIN_LENGTH)
      .max(PARTNER_PASSWORD_MAX_LENGTH),
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    path: ["confirmPassword"],
  });

function invalidFields(
  correlationId: string,
  fieldErrors: Readonly<Record<string, string>>,
): Response {
  return createPartnerPortalV2DescriptorResponse(
    createPortalV2ErrorResponse("invalid_fields", correlationId, {
      status: 422,
      fieldErrors,
    }),
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
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
    if (!principal.accountId) {
      return createPartnerPortalV2ErrorResponse(
        "account_access_required",
        403,
        correlationId,
      );
    }
    if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_password_change",
      request,
      identity: { kind: "partner_user", value: principal.partnerUserId },
    });
    if (rateLimit.limited) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("rate_limited", correlationId, {
          additionalHeaders: {
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        }),
      );
    }

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
    const parsed = PasswordChangeSchema.safeParse(raw);
    if (!parsed.success) {
      const passwordTooShort = parsed.error.issues.some(
        (issue) =>
          issue.path[0] === "newPassword" && issue.code === "too_small",
      );
      const confirmationMismatch = parsed.error.issues.some(
        (issue) => issue.path[0] === "confirmPassword",
      );
      return invalidFields(correlationId, {
        ...(passwordTooShort
          ? {
              newPassword: `Use at least ${PARTNER_PASSWORD_MIN_LENGTH} characters.`,
            }
          : {}),
        ...(confirmationMismatch
          ? { confirmPassword: "Enter the same new password again." }
          : {}),
        ...(!passwordTooShort && !confirmationMismatch
          ? { newPassword: "Enter a valid password." }
          : {}),
      });
    }

    const changed = await changePartnerPassword({
      actor: {
        partnerUserId: principal.partnerUserId,
        email: principal.email,
        roleKey: principal.roleKey,
        accountId: principal.accountId,
        membershipId: principal.membershipId,
        sessionId: principal.session.id,
        correlationId,
      },
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });
    if (changed.kind === "success") {
      return createPartnerPortalV2SuccessResponse(
        {
          ok: true,
          passwordSet: true,
          changedAt: changed.changedAt.toISOString(),
          otherSessionsRevoked: changed.otherSessionsRevoked,
        },
        correlationId,
      );
    }
    if (changed.kind === "current_password_required") {
      return invalidFields(correlationId, {
        currentPassword: "Enter your current password to make this change.",
      });
    }
    if (changed.kind === "invalid_current_password") {
      return invalidFields(correlationId, {
        currentPassword: "The current password is incorrect.",
      });
    }
    if (changed.kind === "password_reused") {
      return invalidFields(correlationId, {
        newPassword: "Choose a password you are not already using.",
      });
    }
    if (changed.kind === "recent_authentication_required") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("mfa_step_up_required", correlationId, {
          status: 403,
          alternatives: [
            {
              action: "reauthenticate",
              label: "Sign in again with your password",
              href: "/partners/login?returnTo=%2Fpartners%2Fsettings",
            },
          ],
        }),
      );
    }
    if (changed.kind === "session_unavailable") {
      return createPartnerPortalV2ErrorResponse(
        "session_revoked",
        401,
        correlationId,
      );
    }
    if (changed.kind === "user_unavailable") {
      return createPartnerPortalV2ErrorResponse(
        "unauthorized",
        401,
        correlationId,
      );
    }
    return createPartnerPortalV2ErrorResponse(
      "internal_error",
      500,
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
