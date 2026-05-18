import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "../../../../../../mobile/lib/session";

export const dynamic = "force-dynamic";

type SendMessageBody = {
  body?: unknown;
  channel?: unknown;
  allowDncOverride?: unknown;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hasMobilePermission(session.teamMember.permissions, "messages.send")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { threadId } = await context.params;
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return NextResponse.json({ error: "thread_required" }, { status: 400 });
  }

  const input = (await request.json().catch(() => null)) as SendMessageBody | null;
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  const channel = typeof input?.channel === "string" ? input.channel.trim() : "";
  const allowDncOverride = input?.allowDncOverride === true;

  if (!body) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/inbox/threads/${encodeURIComponent(normalizedThreadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body,
      direction: "outbound",
      ...(allowDncOverride ? { allowDncOverride: true } : {}),
      ...(channel ? { channel } : {})
    })
  });

  const payload: unknown = await apiResponse.json().catch(() => null);
  return NextResponse.json(payload ?? { ok: apiResponse.ok }, { status: apiResponse.status });
}
