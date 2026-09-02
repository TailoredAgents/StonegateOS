import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { loadPartnerQuoteV2StaffContext } from "@/lib/partner-quote-v2-staff-context";
import { teamMutationErrorResponse, teamMutationExceptionResponse } from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ accountId?: string }> },
): Promise<Response> {
  const commercialPermission = await requirePermission(
    request,
    "partners.commercial.read",
  );
  if (commercialPermission) return commercialPermission;
  const quotePermission = await requirePermission(request, "quotes.write");
  if (quotePermission) return quotePermission;
  const accountId = (await context.params).accountId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(accountId)) {
    return teamMutationErrorResponse(
      "invalid",
      "The Partner quote context was not found.",
      { status: 404 },
    );
  }
  try {
    const result = await loadPartnerQuoteV2StaffContext({ accountId });
    if (!result) {
      return teamMutationErrorResponse(
        "invalid",
        "The Partner quote context was not found.",
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: true, ...result },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}
