import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  auditPartnerLocationPortfolio,
  canManageAccountLocationPortfolio,
  isLocationImportRowResult,
  isPortalLocationUuid,
  partnerLocationImports,
  serializePartnerLocationCorrectionCsv,
} from "@/lib/partner-location-portfolio";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
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
    const result = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(partnerLocationImports)
        .where(
          and(
            eq(partnerLocationImports.id, importId),
            eq(partnerLocationImports.partnerAccountId, principal.accountId!),
          ),
        )
        .limit(1);
      if (!operation) return null;
      const results = Array.isArray(operation.rowResults)
        ? operation.rowResults.filter(isLocationImportRowResult)
        : [];
      if (results.length !== operation.rowCount) {
        throw new Error("partner_location_import_evidence_invalid");
      }
      await auditPartnerLocationPortfolio(tx, {
        principal,
        correlationId,
        action: "partner.location_import.corrections_exported",
        entityType: "partner_location_import",
        entityId: operation.id,
        meta: {
          partnerAccountId: principal.accountId,
          rowCount: operation.rowCount,
          invalidRowCount: operation.invalidRowCount,
        },
      });
      return serializePartnerLocationCorrectionCsv(results);
    });
    if (result === null) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    return new Response(`\uFEFF${result}`, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="location-import-${importId}-corrections.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "x-correlation-id": correlationId,
        Vary: "Authorization",
      },
    });
  } catch (error) {
    console.error("[partner-portal-v2] location corrections export failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
