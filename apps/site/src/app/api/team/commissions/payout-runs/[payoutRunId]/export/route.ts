import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  if (!hasOwner) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    return NextResponse.json({ error: "missing_payout_run_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/commissions/payout-runs/${payoutRunId}/export`);
  const body = await apiResponse.text();

  const response = new NextResponse(body, { status: apiResponse.status });
  const contentType = apiResponse.headers.get("content-type");
  const contentDisposition = apiResponse.headers.get("content-disposition");
  if (contentType) response.headers.set("Content-Type", contentType);
  if (contentDisposition) response.headers.set("Content-Disposition", contentDisposition);
  return response;
}

