import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import {
  loadPartnerPortalOperationsReport,
  PARTNER_OPERATIONS_RANGE_DAYS,
  type PartnerOperationsRangeDays,
} from "@/lib/partner-portal-operations-reporting";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function parseRangeDays(
  params: URLSearchParams,
): PartnerOperationsRangeDays | null {
  if ([...params.keys()].some((key) => key !== "rangeDays")) return null;
  const values = params.getAll("rangeDays");
  if (values.length > 1) return null;
  const candidate = Number(values[0] ?? "7");
  return PARTNER_OPERATIONS_RANGE_DAYS.includes(
    candidate as PartnerOperationsRangeDays,
  )
    ? (candidate as PartnerOperationsRangeDays)
    : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.accounts.read",
  );
  if (permissionError) return permissionError;

  const correlationId = readPortalV2CorrelationId(request.headers);
  const rangeDays = parseRangeDays(request.nextUrl.searchParams);
  if (!rangeDays) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_query",
        message: "rangeDays must be 1, 7, 14, or 30.",
        correlationId,
      },
      {
        status: 422,
        headers: { ...NO_STORE_HEADERS, "x-correlation-id": correlationId },
      },
    );
  }

  try {
    const report = await loadPartnerPortalOperationsReport({ rangeDays });
    return NextResponse.json(
      { ok: true, report },
      { headers: { ...NO_STORE_HEADERS, "x-correlation-id": correlationId } },
    );
  } catch (error) {
    console.error("[partner.portal.operations] report_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_operations_unavailable",
        message: "Partner operations telemetry could not be loaded. Try again.",
        retryable: true,
        correlationId,
      },
      {
        status: 503,
        headers: { ...NO_STORE_HEADERS, "x-correlation-id": correlationId },
      },
    );
  }
}
