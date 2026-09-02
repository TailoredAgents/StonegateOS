import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { switchPartnerSessionAccount } from "@/lib/partner-account-authorization";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import { requirePartnerSession } from "@/lib/partner-portal-auth";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    // Authentication intentionally precedes body reads and account discovery.
    const authentication = await requirePartnerSession(request);
    if (!authentication.ok) {
      return createPartnerPortalV2ErrorResponse(
        authentication.error,
        authentication.status,
        correlationId,
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = await readBoundedJsonRequest(request, {
        maximumBytes: 1_024,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        return createPartnerPortalV2ErrorResponse(
          error.code === "invalid_body" ? "invalid_body" : "invalid_request",
          error.status,
          correlationId,
        );
      }
      throw error;
    }

    const payloadKeys = isRecord(rawPayload) ? Object.keys(rawPayload) : [];
    if (
      !isRecord(rawPayload) ||
      payloadKeys.length < 1 ||
      payloadKeys.length > 2 ||
      payloadKeys.some((key) => !["accountId", "makeDefault"].includes(key)) ||
      typeof rawPayload["accountId"] !== "string" ||
      !UUID_PATTERN.test(rawPayload["accountId"].trim()) ||
      ("makeDefault" in rawPayload &&
        typeof rawPayload["makeDefault"] !== "boolean")
    ) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }

    const switched = await switchPartnerSessionAccount(
      authentication,
      rawPayload["accountId"].trim().toLowerCase(),
      {
        makeDefault: rawPayload["makeDefault"] === true,
        correlationId,
      },
    );
    if (!switched.ok) {
      return createPartnerPortalV2ErrorResponse(
        switched.error,
        switched.status,
        correlationId,
      );
    }

    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        currentAccountId: switched.accountId,
        currentMembershipId: switched.membershipId,
        defaultAccount: switched.defaultAccount,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
