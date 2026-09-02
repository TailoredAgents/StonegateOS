import type { NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { getDb, partnerAccountLocations } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  auditPartnerLocationPortfolio,
  serializePartnerLocationCsv,
} from "@/lib/partner-location-portfolio";
import { createPartnerLocationAccessCondition } from "@/lib/partner-portal-v2-resource-authorization";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const MAX_LOCATION_EXPORT_ROWS = 1_000;

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "reports.operational.export",
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
    const rows = await db.transaction(async (tx) => {
      const result = await tx
        .select()
        .from(partnerAccountLocations)
        .where(createPartnerLocationAccessCondition(principal))
        .orderBy(
          asc(partnerAccountLocations.siteName),
          asc(partnerAccountLocations.id),
        )
        .limit(MAX_LOCATION_EXPORT_ROWS + 1);
      if (result.length > MAX_LOCATION_EXPORT_ROWS) return null;
      await auditPartnerLocationPortfolio(tx, {
        principal,
        correlationId,
        action: "partner.location_directory.exported",
        entityType: "partner_account",
        entityId: principal.accountId!,
        requiredPermission: "reports.operational.export",
        meta: {
          partnerAccountId: principal.accountId,
          rowCount: result.length,
          scoped: principal.accessLevel !== "account",
          includesAccessSecrets: false,
        },
      });
      return result;
    });
    if (rows === null) {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    const externalIds = new Map(
      rows.flatMap((row) =>
        row.externalPropertyId
          ? [[row.id, row.externalPropertyId] as const]
          : [],
      ),
    );
    const csv = serializePartnerLocationCsv(rows, externalIds);
    return new Response(`\uFEFF${csv}`, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="stonegate-locations.csv"',
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "x-correlation-id": correlationId,
        Vary: "Authorization",
      },
    });
  } catch (error) {
    console.error("[partner-portal-v2] location directory export failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
