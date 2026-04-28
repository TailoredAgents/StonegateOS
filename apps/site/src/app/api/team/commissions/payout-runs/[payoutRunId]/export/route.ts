import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "@/app/api/team/auth";
import { callAdminApi } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> }
): Promise<Response> {
  const auth = await requireTeamRole(request, { roles: ["owner"], returnJson: true });
  if (!auth.ok) return auth.response;

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
