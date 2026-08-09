import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { parseInboxThreadRouteId } from "@/app/team/inbox-thread-page";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const QUERY_KEYS = new Set(["cursor", "limit"]);

type RouteContext = {
  params: Promise<{ threadId?: string }>;
};

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "messages.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const { threadId } = await context.params;
  const parsedThreadId = parseInboxThreadRouteId(threadId);
  if (!parsedThreadId.ok) {
    return NextResponse.json(
      {
        error: parsedThreadId.error,
        field: "threadId",
        message: parsedThreadId.message,
      },
      {
        status: parsedThreadId.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  const resolvedThreadId = parsedThreadId.threadId;

  const input = request.nextUrl.searchParams;
  for (const key of input.keys()) {
    if (!QUERY_KEYS.has(key)) {
      return NextResponse.json(
        {
          error: "invalid_message_pagination",
          field: key,
          message: `Unsupported conversation-page parameter: ${key}.`,
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    for (const value of input.getAll(key)) {
      params.append(key, value);
    }
  }
  const query = params.toString();
  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/inbox/threads/${encodeURIComponent(resolvedThreadId)}${query ? `?${query}` : ""}`,
    { method: "GET" },
  ).catch(() => null);
  if (!upstream) {
    return NextResponse.json(
      {
        error: "upstream_unreachable",
        message: "The selected conversation could not be reached.",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const bodyText = await upstream.text().catch(() => "");
  return new NextResponse(bodyText, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "private, no-store",
    },
  });
}
