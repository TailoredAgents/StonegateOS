import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { listPartnerServiceReviews } from "@/lib/partner-service-review-queue";
export async function GET(request: NextRequest): Promise<Response> {
  for (const permission of [
    "partners.accounts.read",
    "appointments.read",
  ] as const) {
    const denied = await requirePermission(request, permission);
    if (denied) return denied;
  }
  const result = await listPartnerServiceReviews(request.nextUrl.searchParams);
  return NextResponse.json(result ?? { ok: false, error: "invalid_fields" }, {
    status: result ? 200 : 422,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
