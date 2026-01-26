import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamRole } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLen = 60;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const returnJson = wantsJson(request);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");
  const auth = await requireTeamRole(request, { returnJson, redirectTo, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  let contactId: unknown;
  let body: unknown;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await request.json().catch(() => null)) as unknown;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      contactId = record["contactId"];
      body = record["body"];
    }
  } else {
    const formData = await request.formData();
    contactId = formData.get("contactId");
    body = formData.get("body");
  }

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    if (returnJson) {
      return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    return response;
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    if (returnJson) {
      return NextResponse.json({ error: "note_body_required" }, { status: 400 });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Note body required", path: "/" });
    return response;
  }

  const bodyText = body.trim();

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: makeNoteTitle(bodyText),
    notes: bodyText,
    status: "completed"
  };

  const apiResponse = await callAdminApi(`/api/admin/crm/tasks`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!apiResponse.ok) {
    let message = "Unable to add note";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    if (returnJson) {
      const status = apiResponse.status >= 400 ? apiResponse.status : 500;
      return NextResponse.json({ error: "note_create_failed", message }, { status });
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  if (returnJson) {
    const data = (await apiResponse.json().catch(() => null)) as unknown;
    const task = data && typeof data === "object" ? (data as Record<string, unknown>)["task"] : null;
    if (task && typeof task === "object") {
      const record = task as Record<string, unknown>;
      const id = typeof record["id"] === "string" ? record["id"] : null;
      const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : null;
      const updatedAt = typeof record["updatedAt"] === "string" ? record["updatedAt"] : null;
      if (id && createdAt && updatedAt) {
        return NextResponse.json(
          {
            note: {
              id,
              body: bodyText,
              createdAt,
              updatedAt
            }
          },
          { status: 200 }
        );
      }
    }

    return NextResponse.json({ error: "note_create_failed" }, { status: 500 });
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note added", path: "/" });
  return response;
}
