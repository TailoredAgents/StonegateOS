import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  listStaffAccessApplications,
  parseStaffAccessApplicationListQuery,
} from "@/lib/partner-access-application-administration";
import {
  TeamMutationFailure,
  teamMutationExceptionResponse,
} from "@/lib/team-mutation";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const permissionError = await requirePermission(
    request,
    "partners.applications.read",
  );
  if (permissionError) return permissionError;

  try {
    const query = parseStaffAccessApplicationListQuery(
      request.nextUrl.searchParams,
    );
    const applications = await listStaffAccessApplications(query);
    return NextResponse.json(
      {
        ok: true,
        applications,
        page: {
          limit: query.limit,
          returned: applications.length,
          bounded: true,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof TeamMutationFailure) {
      const response = teamMutationExceptionResponse(error);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    console.error("[partner-access-applications] list_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    const response = teamMutationExceptionResponse(
      new TeamMutationFailure(
        "internal",
        "Access applications could not be loaded. Try again.",
        { retryable: true },
      ),
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
