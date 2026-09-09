import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import {
  getPartnerRescheduleRequestForStaff,
  requirePortalUuid,
} from "@/lib/partner-portal-v2-scheduling";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import { portalSchedulingExceptionResponse } from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const denied = await requirePermission(request, "partners.accounts.read");
  if (denied) return denied;
  const scheduleDenied = await requirePermission(request, "appointments.read");
  if (scheduleDenied) return scheduleDenied;
  try {
    const result = await getPartnerRescheduleRequestForStaff(
      requirePortalUuid((await context.params).requestId, "requestId"),
    );
    return NextResponse.json(
      { ok: true, ...result },
      {
        headers: {
          "Cache-Control": "private, no-store",
          ETag: `"${result.request.updatedAt}"`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(
      error,
      readPortalV2CorrelationId(request.headers),
    );
  }
}
