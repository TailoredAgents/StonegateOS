import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, partnerAccounts } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  canManageAccountLocationPortfolio,
  isPortalLocationUuid,
  partnerLocationDirectoryEtag,
  partnerLocationImports,
  serializePartnerLocationImportOperation,
} from "@/lib/partner-location-portfolio";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ importId: string }> };

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
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
  const { importId } = await context.params;
  if (
    !canManageAccountLocationPortfolio(principal) ||
    !isPortalLocationUuid(importId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const db = getDb();
    const [row] = await db
      .select({
        operation: partnerLocationImports,
        directoryVersion: partnerAccounts.locationDirectoryVersion,
      })
      .from(partnerLocationImports)
      .innerJoin(
        partnerAccounts,
        eq(partnerLocationImports.partnerAccountId, partnerAccounts.id),
      )
      .where(
        and(
          eq(partnerLocationImports.id, importId),
          eq(partnerLocationImports.partnerAccountId, principal.accountId!),
        ),
      )
      .limit(1);
    if (!row) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const operation = serializePartnerLocationImportOperation(row.operation);
    return createPartnerPortalV2SuccessResponse(
      { ok: true, import: operation },
      correlationId,
      200,
      {
        ETag: operation.etag,
        "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
          accountId: principal.accountId!,
          version: row.directoryVersion,
        }),
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] location import detail failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
