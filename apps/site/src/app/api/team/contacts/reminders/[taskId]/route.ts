import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);

  if (!hasOwner && !hasCrew) {
    if (returnJson) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/team?tab=contacts", request.url), 303);
  }

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

