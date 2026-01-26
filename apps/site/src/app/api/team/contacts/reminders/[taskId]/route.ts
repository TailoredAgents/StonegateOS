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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const returnJson = wantsJson(request);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");
  const auth = await requireTeamRole(request, { returnJson, redirectTo, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  const { taskId } = await context.params;
  const id = taskId?.trim() ?? "";
  if (!id) {
    return NextResponse.json({ error: "task_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const title = typeof record["title"] === "string" ? record["title"].trim() : null;
  const notes = typeof record["notes"] === "string" ? record["notes"].trim() : null;
  const dueAt = typeof record["dueAt"] === "string" ? record["dueAt"].trim() : null;

  const apiResponse = await callAdminApi(`/api/admin/crm/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(title !== null ? { title: title.length ? title : "Call back" } : {}),
      ...(notes !== null ? { notes: notes.length ? notes : null } : {}),
      ...(dueAt !== null ? { dueAt: dueAt.length ? dueAt : null } : {})
    })
  });

  if (!apiResponse.ok) {
    let message = "Unable to update reminder";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    return NextResponse.json({ error: "reminder_update_failed", message }, { status: apiResponse.status });
  }

  const data = (await apiResponse.json().catch(() => null)) as unknown;
  const task = data && typeof data === "object" ? (data as Record<string, unknown>)["task"] : null;
  if (!task || typeof task !== "object") {
    return NextResponse.json({ error: "reminder_update_failed" }, { status: 500 });
  }

  return NextResponse.json({ reminder: task }, { status: 200 });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const returnJson = wantsJson(request);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");
  const auth = await requireTeamRole(request, { returnJson, redirectTo, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  const { taskId } = await context.params;
  const id = taskId?.trim() ?? "";
  if (!id) {
    return NextResponse.json({ error: "task_id_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/crm/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" })
  });

  if (!apiResponse.ok) {
    let message = "Unable to complete reminder";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    return NextResponse.json({ error: "reminder_complete_failed", message }, { status: apiResponse.status });
  }

  return NextResponse.json({ completed: true, taskId: id }, { status: 200 });
}
