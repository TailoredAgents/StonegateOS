import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, {
    roles: ["owner", "office"],
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const body = await request.text();
  const apiResponse = await callAdminApi("/api/admin/sales/simulated-chat", {
    method: "POST",
    body,
  });
  const text = await apiResponse.text();

  return new NextResponse(text, {
    status: apiResponse.status,
    headers: {
      "Content-Type":
        apiResponse.headers.get("Content-Type") ?? "application/json",
    },
  });
}
