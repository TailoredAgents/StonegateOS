import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "../../auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { roles: ["owner", "office", "crew"], returnJson: true });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = url.searchParams.get("contactId")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json({ ok: false, message: "Missing contact id." }, { status: 400 });
  }

  const response = await callAdminApi(`/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`);
  const payload = (await response.json().catch(() => null)) as any;

  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "Unable to load contact.";
    return NextResponse.json({ ok: false, message }, { status: response.status });
  }

  const contact = payload?.contacts?.[0] ?? payload?.contact ?? null;
  if (!contact || typeof contact !== "object") {
    return NextResponse.json({ ok: false, message: "Contact not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, contact });
}
