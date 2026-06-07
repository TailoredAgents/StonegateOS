import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "../../auth";
import { callAdminApi } from "@/app/team/lib/api";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { returnJson: true, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  const contactId = (request.nextUrl.searchParams.get("contactId") ?? "").trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const params = new URLSearchParams({ contactId });
  const limit = (request.nextUrl.searchParams.get("limit") ?? "").trim();
  if (limit) params.set("limit", limit);

  const res = await callAdminApi(`/api/admin/inbox/timeline?${params.toString()}`, { method: "GET" }).catch(() => null);
  if (!res) return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });

  const bodyText = await res.text().catch(() => "");
  return new NextResponse(bodyText, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
