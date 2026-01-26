import { callAdminApi } from "@/app/team/lib/api";
import { NextResponse } from "next/server";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = url.searchParams.get("contactId")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const upstream = await callAdminApi(`/api/admin/contacts/${encodeURIComponent(contactId)}/instant-quote-photos`, {
    headers: { Accept: "application/json" }
  });

  const body = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
}

