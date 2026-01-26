import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { roles: ["owner", "office", "crew"], returnJson: true });
  if (!auth.ok) return auth.response;

  const payload = (await request.json().catch(() => null)) as { contactId?: string; disposition?: string } | null;
  const contactId = typeof payload?.contactId === "string" ? payload.contactId.trim() : "";
  const disposition = typeof payload?.disposition === "string" ? payload.disposition.trim() : "";
  if (!contactId) {
    return NextResponse.json({ ok: false, message: "Missing contact id." }, { status: 400 });
  }
  if (!disposition) {
    return NextResponse.json({ ok: false, message: "Missing disposition." }, { status: 400 });
  }

  const response = await callAdminApi("/api/admin/sales/disposition", {
    method: "POST",
    body: JSON.stringify({ contactId, disposition })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ ok: false, message: text || "Unable to update disposition." }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}
