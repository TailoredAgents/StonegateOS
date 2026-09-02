import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { verifyAddress } from "@/lib/geocode";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { findPartnerLocationDuplicates } from "@/lib/partner-location-portfolio";
import { PartnerLocationValidateSchema } from "@/lib/partner-portal-v2-locations";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  getServiceAreaPolicy,
  isCityAllowed,
  isPostalCodeAllowed,
} from "@/lib/policy";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "properties.manage",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId || principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1_024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerLocationValidateSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const input = parsed.data;
    const accountId = principal.accountId;
    const [verification, serviceArea] = await Promise.all([
      verifyAddress({
        addressLine1: input.address.line1,
        addressLine2: input.address.line2,
        city: input.address.city,
        state: input.address.state,
        postalCode: input.address.postalCode,
      }),
      getServiceAreaPolicy(),
    ]);
    const duplicates = await getDb().transaction((tx) =>
      findPartnerLocationDuplicates(tx, {
        accountId,
        externalPropertyId: input.externalPropertyId ?? null,
        excludeLocationId: input.excludeLocationId,
        address: {
          addressLine1: input.address.line1,
          addressLine2: input.address.line2,
          city: input.address.city,
          state: input.address.state,
          postalCode: input.address.postalCode,
        },
      }),
    );
    const policyEligible =
      isPostalCodeAllowed(input.address.postalCode, serviceArea) &&
      (serviceArea.cityAllowlist.length === 0 ||
        isCityAllowed(input.address.city, serviceArea));
    const exactDuplicate = duplicates.some(
      (candidate) => candidate.confidence === 100,
    );
    const probableDuplicate = duplicates.some(
      (candidate) => candidate.confidence >= 86,
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        validation: {
          status: exactDuplicate
            ? "duplicate"
            : verification.status === "verified" && !probableDuplicate
              ? "verified"
              : "review_required",
          verification,
          serviceArea: {
            status:
              verification.status !== "verified"
                ? "review"
                : policyEligible
                  ? "eligible"
                  : "outside",
            policyEligible,
          },
          duplicates,
          canCreateForReview: !exactDuplicate,
        },
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] location validation failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
