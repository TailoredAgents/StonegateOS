import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiForCurrentSession } from "@/app/team/lib/api";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "../../../../../../mobile/lib/session";

export const dynamic = "force-dynamic";

type SendMessageBody = {
  body?: unknown;
  channel?: unknown;
  allowDncOverride?: unknown;
  audience?: unknown;
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalizedThreadId)) {
    return NextResponse.json({ error: "thread_required" }, { status: 400 });
  }

  const input = (await request.json().catch(() => null)) as SendMessageBody | null;
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  const channel = typeof input?.channel === "string" ? input.channel.trim() : "";
  const allowDncOverride = input?.allowDncOverride === true;
  const audience = input?.audience === "partner" || input?.audience === "internal" ? input.audience : undefined;
  const idempotencyKey = request.headers.get("Idempotency-Key");

  if (!body || body.length > 5_000) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApiForCurrentSession(`/api/admin/inbox/threads/${encodeURIComponent(normalizedThreadId)}/messages`, {
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    body: JSON.stringify({
      body,
      direction: "outbound",
      ...(audience ? { audience } : {}),
      ...(allowDncOverride ? { allowDncOverride: true } : {}),
      ...(channel ? { channel } : {})
    })
  });

  const payload: unknown = await apiResponse.json().catch(() => null);
  return NextResponse.json(payload ?? { ok: apiResponse.ok }, { status: apiResponse.status });
}
