import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

export async function POST(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);

  if (!hasOwner && !hasCrew) {
    if (returnJson) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(getSafeRedirectUrl(request, "/team?tab=contacts"), 303);
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const contactId = typeof record["contactId"] === "string" ? record["contactId"].trim() : "";
  const dueAt = typeof record["dueAt"] === "string" ? record["dueAt"].trim() : "";
  const title = typeof record["title"] === "string" ? record["title"].trim() : "";
  const notes = typeof record["notes"] === "string" ? record["notes"].trim() : "";

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }
  if (!dueAt) {
    return NextResponse.json({ error: "due_at_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi("/api/admin/crm/reminders", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      dueAt,
      title: title.length ? title : undefined,
      notes: notes.length ? notes : undefined
    })
  });

  if (!apiResponse.ok) {
    let message = "Unable to create reminder";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    return NextResponse.json({ error: "reminder_create_failed", message }, { status: apiResponse.status });
  }

  const data = (await apiResponse.json().catch(() => null)) as unknown;
  const reminder = data && typeof data === "object" ? (data as Record<string, unknown>)["reminder"] : null;
  if (!reminder || typeof reminder !== "object") {
    return NextResponse.json({ error: "reminder_create_failed" }, { status: 500 });
  }

  return NextResponse.json({ reminder }, { status: 200 });
}
