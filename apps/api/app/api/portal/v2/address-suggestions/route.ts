import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  normalizePartnerAddressSuggestionQuery,
  PARTNER_ADDRESS_SUGGESTION_ATTRIBUTION,
  PartnerAddressSuggestionsUnavailableError,
  suggestPartnerAddresses,
} from "@/lib/partner-address-suggestions";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const QuerySchema = z.object({ query: z.string() }).strict();

/** A POST keeps typed address text out of proxy/access-log URLs. No location is saved. */
export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request))
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "properties.manage",
    );
    if (!authorization.ok)
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    const { principal } = authorization;
    if (!principal.accountId || !principal.membershipId)
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    if (principal.accessLevel !== "account")
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    if (
      !arePartnerPortalV2ReadsEnabled(principal.accountId) ||
      !arePartnerPortalV2WritesEnabled(principal.accountId)
    )
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    if (request.nextUrl.search)
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
        maximumBytes: 2_048,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_body",
        error instanceof BoundedJsonRequestError ? error.status : 400,
        correlationId,
      );
    }
    const parsed = QuerySchema.safeParse(raw);
    const query = parsed.success
      ? normalizePartnerAddressSuggestionQuery(parsed.data.query)
      : null;
    if (!query)
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_address_suggestions",
      request,
      identity: { kind: "partner_user", value: principal.partnerUserId },
    });
    if (rateLimit.limited)
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("rate_limited", correlationId, {
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        }),
      );
    const suggestions = await suggestPartnerAddresses(query, request.signal);
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        suggestions,
        attribution: PARTNER_ADDRESS_SUGGESTION_ATTRIBUTION,
      },
      correlationId,
    );
  } catch (error) {
    if (error instanceof PartnerAddressSuggestionsUnavailableError) {
      if (error.reason !== "cancelled")
        console.warn("[partner-portal-v2] address suggestions unavailable", {
          correlationId,
          operation: "address_suggestions.read",
          reason: error.reason,
          ...(error.providerStatus
            ? { providerStatus: error.providerStatus }
            : {}),
        });
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    return createPartnerPortalV2UnexpectedResponse(
      correlationId,
      error,
      "address_suggestions.read",
    );
  }
}
