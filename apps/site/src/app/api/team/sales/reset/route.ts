import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { roles: ["owner", "office"], returnJson: true });
  if (!auth.ok) return auth.response;

  const response = await callAdminApi("/api/admin/sales/reset", {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ ok: false, message: text || "Unable to reset Sales HQ." }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}
