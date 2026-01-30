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
  if (!contactId) return jsonError("Contact ID missing");

  const payload: Record<string, unknown> = {};
  if ("phone" in record) {
    const phoneRaw = record["phone"];
    if (typeof phoneRaw === "string") {
      payload["phone"] = phoneRaw.trim();
    } else if (phoneRaw === null) {
      payload["phone"] = null;
    } else {
      return jsonError("Invalid phone");
    }
  }

  if ("email" in record) {
    const emailRaw = record["email"];
    if (typeof emailRaw === "string") {
      payload["email"] = emailRaw.trim();
    } else if (emailRaw === null) {
      payload["email"] = null;
    } else {
      return jsonError("Invalid email");
    }
  }

  if (Object.keys(payload).length === 0) {
    return jsonError("No changes to apply");
  }

  const apiResponse = await callAdminApi(`/api/admin/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!apiResponse.ok) {
    let message = "Unable to update contact";
    try {
      const data = (await apiResponse.json().catch(() => null)) as { message?: string; error?: string } | null;
      const candidate = data?.message ?? data?.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
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

