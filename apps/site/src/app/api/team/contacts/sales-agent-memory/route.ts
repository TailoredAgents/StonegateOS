import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function readContactId(url: URL): string {
  return url.searchParams.get("contactId")?.trim() ?? "";
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const auth = await requireTeamPrincipal(request, {
    permissions: includeQuotePrice
      ? (["contacts.read", "quotes.read"] as const)
      : "contacts.read",
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-memory${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const body: unknown = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, {
    status: upstream.status,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const auth = await requireTeamPrincipal(request, {
    permissions: includeQuotePrice
      ? (["contacts.write", "quotes.read"] as const)
      : "contacts.write",
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-memory/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );

  const body: unknown = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, {
    status: upstream.status,
  });
}
