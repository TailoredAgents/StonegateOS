import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

type RouteContext = {
  params: Promise<{ messageId?: string; index?: string }>;
};

async function proxy(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "messages.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const { messageId, index } = await context.params;
  if (!messageId || !index) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/inbox/messages/${messageId}/media/${index}`,
    {
      method: request.method,
    },
  );
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    return new NextResponse("media_fetch_failed", {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers();
  for (const name of [
    "cache-control",
    "content-disposition",
    "content-length",
    "content-security-policy",
    "content-type",
    "cross-origin-resource-policy",
    "x-content-type-options",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return proxy(_request, context);
}

export async function HEAD(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return proxy(request, context);
}
