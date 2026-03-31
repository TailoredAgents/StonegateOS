import { callAdminApi } from "@/app/team/lib/api";
import { NextResponse } from "next/server";

function readContactId(url: URL): string {
  return url.searchParams.get("contactId")?.trim() ?? "";
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstream = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const body = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstream = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );

  const body = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
}
