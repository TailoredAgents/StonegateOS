import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "automation.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const params = new URLSearchParams();
  for (const key of ["q", "limit", "leadId", "channel"] as const) {
    const value = request.nextUrl.searchParams.get(key)?.trim();
    if (value) params.set(key, value);
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/admin/automation/lead?${params.toString()}`,
    { method: "GET" },
  );
  const text = await apiResponse.text();
  return new NextResponse(text, {
    status: apiResponse.status,
    headers: {
      "Content-Type":
        apiResponse.headers.get("Content-Type") ?? "application/json",
    },
  });
}
