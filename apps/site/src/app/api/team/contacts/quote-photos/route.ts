import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: ["contacts.read", "quotes.read"],
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = url.searchParams.get("contactId")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/instant-quote-photos`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const body: unknown = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, {
    status: upstream.status,
  });
}
