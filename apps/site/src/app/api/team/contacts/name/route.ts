import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { returnJson: true, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") {
    return jsonError("Invalid request payload");
  }

  const record = body as Record<string, unknown>;
  const contactId = typeof record["contactId"] === "string" ? record["contactId"].trim() : "";
  const firstName = typeof record["firstName"] === "string" ? record["firstName"].trim() : "";
  const lastName = typeof record["lastName"] === "string" ? record["lastName"].trim() : "";

  if (!contactId) return jsonError("Contact ID missing");
  if (!firstName) return jsonError("First name is required");

  const payload: Record<string, unknown> = { firstName };
  payload["lastName"] = lastName.length > 0 ? lastName : null;

  const apiResponse = await callAdminApi(`/api/admin/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!apiResponse.ok) {
    let message = "Unable to update contact name";
    try {
      const data = (await apiResponse.json()) as { message?: string; error?: string };
      const extracted = data.message ?? data.error;
      if (typeof extracted === "string" && extracted.trim().length > 0) {
        message = extracted.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    const response = NextResponse.json({ ok: false, message }, { status: apiResponse.status });
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: "myst-flash", value: "Contact updated", path: "/" });
  return response;
}
