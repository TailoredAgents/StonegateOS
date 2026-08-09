import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "../../auth";

export const dynamic = "force-dynamic";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = url.searchParams.get("contactId")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json(
      { ok: false, message: "Missing contact id." },
      { status: 400 },
    );
  }

  const response = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`,
  );
  const payload: unknown = await response.json().catch(() => null);
  const payloadObject = isJsonObject(payload) ? payload : null;

  if (!response.ok) {
    const upstreamError = payloadObject?.["error"];
    const message =
      typeof upstreamError === "string"
        ? upstreamError
        : "Unable to load contact.";
    return NextResponse.json(
      { ok: false, message },
      { status: response.status },
    );
  }

  const contacts = payloadObject?.["contacts"];
  const listContact: unknown = Array.isArray(contacts) ? contacts[0] : null;
  const contact: unknown =
    listContact ?? payloadObject?.["contact"] ?? null;
  if (!isJsonObject(contact)) {
    return NextResponse.json(
      { ok: false, message: "Contact not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, contact });
}
