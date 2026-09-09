import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { getPartnerServiceReview } from "@/lib/partner-service-review-queue";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  for (const permission of [
    "partners.accounts.read",
    "appointments.read",
  ] as const) {
    const denied = await requirePermission(request, permission);
    if (denied) return denied;
  }
  const params = request.nextUrl.searchParams;
  if (
    [...params.keys()].some((key) => key !== "accountId") ||
    params.getAll("accountId").length !== 1
  )
    return NextResponse.json(
      { ok: false, error: "invalid_fields" },
      { status: 422, headers: { "Cache-Control": "private, no-store" } },
    );
  const result = await getPartnerServiceReview(
    params.get("accountId") ?? "",
    (await context.params).jobId,
  );
  return NextResponse.json(result ?? { ok: false, error: "not_found" }, {
    status: result ? 200 : 404,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
