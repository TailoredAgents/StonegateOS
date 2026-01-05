import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

type RouteContext = {
  params: Promise<{ messageId?: string; index?: string }>;
};

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { messageId, index } = await context.params;
  if (!messageId || !index) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const upstream = await callAdminApi(`/api/admin/inbox/messages/${messageId}/media/${index}`, {
    method: request.method
  });
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return new NextResponse(text || "media_fetch_failed", {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=60"
    }
  });
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(_request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
