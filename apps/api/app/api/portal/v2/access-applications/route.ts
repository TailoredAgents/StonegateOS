import { NextRequest } from "next/server";
import { POST as requestLegacyPartnerLoginLink } from "../../../public/partners/request-link/route";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  bootstrapPartnerAccessApplication,
  listPartnerAccessApplications,
  parsePartnerAccessApplication,
  partnerApplicationIdentityHash,
} from "@/lib/partner-portal-onboarding";
import {
  createPortalV2IdempotencyErrorResponse,
  createPortalV2ErrorResponse,
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

function serializeApplication(
  row: Awaited<ReturnType<typeof listPartnerAccessApplications>>[number],
) {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    informationRequest:
      row.status === "needs_information" ? row.informationRequest : null,
    emailVerified: Boolean(row.emailVerifiedAt),
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(`${row.id}:${row.version}`),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
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
    const applications = await listPartnerAccessApplications(
      authorization.principal.partnerUserId,
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, applications: applications.map(serializeApplication) },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
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
        maximumBytes: 16_384,
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
    const application = parsePartnerAccessApplication(raw);
    if (!application) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("invalid_fields", correlationId, {
          fieldErrors: {
            application:
              "Review the contact, company, persona, and current terms/privacy selections.",
          },
        }),
      );
    }
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_access_application",
      request,
      identity: { kind: "email", value: application.email },
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
      principal: `public-application:${partnerApplicationIdentityHash(application.email)}`,
      action: "partner.access_application.create",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/access-applications",
      payload: application,
      correlationId,
      execute: async () => {
        await bootstrapPartnerAccessApplication({
          application,
          idempotencyKeyHash: idempotency.keyHash!,
          correlationId,
        });
        const legacyHeaders = new Headers({
          "content-type": "application/json",
        });
        for (const header of [
          "origin",
          "user-agent",
          "x-forwarded-for",
          "x-real-ip",
          "cf-connecting-ip",
          "x-team-auth-rate-limit-bypass",
        ]) {
          const value = request.headers.get(header);
          if (value) legacyHeaders.set(header, value);
        }
        const loginRequest = new NextRequest(
          new URL("/api/public/partners/request-link", request.url),
          {
            method: "POST",
            headers: legacyHeaders,
            body: JSON.stringify({ email: application.email }),
          },
        );
        await requestLegacyPartnerLoginLink(loginRequest).catch(
          () => undefined,
        );
        return {
          status: 202,
          body: {
            ok: true,
            status: "submitted",
            message:
              "Application received. Check your email for a 30-minute sign-in link.",
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
