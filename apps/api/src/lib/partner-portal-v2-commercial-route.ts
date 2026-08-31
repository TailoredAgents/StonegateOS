import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  hasPartnerCapability,
  requirePartnerCapability,
  type PartnerCapability,
} from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import type { PartnerCommercialListResult } from "@/lib/partner-portal-v2-commercial";
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

type CommercialLoader = (input: {
  accountId: string;
  params: URLSearchParams;
}) => Promise<PartnerCommercialListResult>;

export async function handlePartnerCommercialList(input: {
  request: NextRequest;
  capability: PartnerCapability;
  loader: CommercialLoader;
  csvFilename: string;
}): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(input.request.headers);
  const authorization = await requirePartnerCapability(
    input.request,
    input.capability,
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
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  // Commercial rows do not yet carry a property/location scope on every
  // record. Failing closed prevents a scoped membership from seeing account-
  // wide financial information until that relationship is enforceable.
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const requestedFormats = input.request.nextUrl.searchParams.getAll("format");
  if (
    requestedFormats.length === 1 &&
    requestedFormats[0] === "csv" &&
    !hasPartnerCapability(principal, "reports.export")
  ) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }

  try {
    const result = await input.loader({
      accountId: principal.accountId,
      params: input.request.nextUrl.searchParams,
    });
    if (!result.ok) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(result.error, correlationId, {
          status: result.status,
          fieldErrors: result.fieldErrors,
        }),
      );
    }
    if (
      result.format === "csv" &&
      !hasPartnerCapability(principal, "reports.export")
    ) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    if (result.format === "csv") {
      return new NextResponse(result.csv, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${input.csvFilename}"`,
          "Content-Type": "text/csv; charset=utf-8",
          Vary: "Authorization",
          "x-correlation-id": correlationId,
          ...(result.nextCursor ? { "x-next-cursor": result.nextCursor } : {}),
        },
      });
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        data: result.items,
        [result.resource]: result.items,
        page: {
          limit: result.limit,
          nextCursor: result.nextCursor,
          hasMore: Boolean(result.nextCursor),
        },
        ...(result.summary ? { summary: result.summary } : {}),
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] commercial list failed", {
      correlationId,
      accountId: principal.accountId,
      resource: input.csvFilename.replace(/\.csv$/u, ""),
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
