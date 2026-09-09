import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import { isPartnerToolEnabled } from "@/lib/partner-account-workflows";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  PartnerReportError,
  parsePartnerServiceReportQuery,
  partnerServiceReportCsv,
  readPartnerServiceReport,
} from "@/lib/partner-service-reports";
import { renderPartnerServiceReportPdf } from "@/lib/partner-service-report-pdf";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
export const runtime = "nodejs";
export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const { filters } = parsePartnerServiceReportQuery(
      request.nextUrl.searchParams,
    );
    const readCapability =
      filters.kind === "financial"
        ? "reports.financial.read"
        : "reports.operational.read";
    const exportCapability =
      filters.kind === "financial"
        ? "reports.financial.export"
        : "reports.operational.export";
    const authorization = await requirePartnerCapability(
      request,
      readCapability,
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
    if (!arePartnerPortalV2ReadsEnabled(principal.accountId))
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    if (!(await isPartnerToolEnabled(principal.accountId, "reports")))
      return createPartnerPortalV2ErrorResponse(
        "feature_not_enabled",
        404,
        correlationId,
      );
    const mayExport = hasPartnerCapability(principal, exportCapability);
    if (filters.format !== "json" && !mayExport)
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    const report = await readPartnerServiceReport({
      accountId: principal.accountId,
      access: principal,
      params: request.nextUrl.searchParams,
    });
    if (filters.format === "json")
      return createPartnerPortalV2SuccessResponse(
        {
          ok: true,
          ...report,
          reports: report.items,
          permissions: {
            export: mayExport,
            operational: hasPartnerCapability(
              principal,
              "reports.operational.read",
            ),
            financial: hasPartnerCapability(
              principal,
              "reports.financial.read",
            ),
          },
        },
        correlationId,
      );
    if (filters.format === "pdf" && report.count > 1_000)
      throw new PartnerReportError(
        "report_too_large",
        422,
        "A PDF can include up to 1,000 records. Narrow the filters or download CSV.",
      );
    const body =
      filters.format === "pdf"
        ? await renderPartnerServiceReportPdf(report)
        : Buffer.from(partnerServiceReportCsv(report));
    return new Response(new Uint8Array(body), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        Vary: "Authorization",
        "Content-Type":
          filters.format === "pdf"
            ? "application/pdf"
            : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="stonegate-${filters.kind}-report.${filters.format}"`,
        "x-report-as-of": report.asOf,
        "x-report-snapshot-sha256": report.snapshotHash,
        "x-content-sha256": createHash("sha256").update(body).digest("hex"),
        "x-correlation-id": correlationId,
      },
    });
  } catch (error) {
    if (error instanceof PartnerReportError)
      return Response.json(
        {
          ok: false,
          error: error.code,
          message: error.message,
          retryable: false,
          correlationId,
        },
        {
          status: error.status,
          headers: {
            "Cache-Control": "private, no-store",
            "x-correlation-id": correlationId,
          },
        },
      );
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
