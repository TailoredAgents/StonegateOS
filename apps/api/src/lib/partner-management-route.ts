import type { TeamPermission } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminRequest } from "../../app/api/web/admin";
import { listPartnerManagementResource } from "@/lib/partner-management-directory";
import {
  PartnerManagementListInputError,
  parsePartnerManagementListQuery,
  type PartnerManagementResource,
} from "@/lib/partner-management-list";
import { requirePermission } from "@/lib/permissions";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function partnerManagementListResponse(
  request: NextRequest,
  resource: PartnerManagementResource,
  permission: TeamPermission,
  authorizationVerified = false,
): Promise<Response> {
  if (!authorizationVerified) {
    if (!isAdminRequest(request)) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const permissionError = await requirePermission(request, permission);
    if (permissionError) return permissionError;
  }

  try {
    const query = parsePartnerManagementListQuery(
      request.nextUrl.searchParams,
      resource,
    );
    const result = await listPartnerManagementResource(resource, query);
    return NextResponse.json(
      { ok: true, resource, ...result },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof PartnerManagementListInputError) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_query",
          message: error.message,
          fieldErrors: { [error.field]: error.message },
        },
        { status: 422, headers: NO_STORE_HEADERS },
      );
    }
    console.error("[partner-management] list_failed", {
      resource,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_management_unavailable",
        message: "Partner administration data could not be loaded. Try again.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
