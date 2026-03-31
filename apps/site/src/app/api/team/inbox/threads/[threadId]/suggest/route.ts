import { callAdminApi } from "@/app/team/lib/api";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ threadId?: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!resolvedThreadId) {
    return NextResponse.json({ ok: false, error: "thread_id_required" }, { status: 400 });
  }

  const body = await request.text().catch(() => "");
  const upstream = await callAdminApi(
    `/api/admin/inbox/threads/${encodeURIComponent(resolvedThreadId)}/suggest`,
    {
      method: "POST",
      body: body.trim().length > 0 ? body : JSON.stringify({}),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    },
  );

  const payload = await upstream.json().catch(() => null);
  return NextResponse.json(payload ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
}
