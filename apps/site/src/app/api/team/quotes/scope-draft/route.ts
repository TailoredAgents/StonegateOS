import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "quotes.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const payload: unknown = await request.json().catch(() => ({}));
  const response = await callAdminApiAs(
    auth.principal,
    "/api/admin/tools/quote-scope",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(data ?? { error: "draft_failed" }, {
      status: response.status,
    });
  }
  return NextResponse.json(data);
}
