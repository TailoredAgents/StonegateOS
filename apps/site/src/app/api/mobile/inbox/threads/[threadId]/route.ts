import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "../../../../../mobile/lib/session";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hasMobilePermission(session.teamMember.permissions, "messages.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { threadId } = await context.params;
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return NextResponse.json({ error: "thread_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/inbox/threads/${encodeURIComponent(normalizedThreadId)}`, {
    method: "GET"
  });
  const payload: unknown = await apiResponse.json().catch(() => null);
  return NextResponse.json(payload ?? { error: "thread_load_failed" }, { status: apiResponse.status });
}
