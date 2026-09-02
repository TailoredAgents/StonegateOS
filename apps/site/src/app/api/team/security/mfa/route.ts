import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

function proxyResponse(response: Response, body: string): Response {
  return new Response(body, {
    status: response.status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      ...(response.headers.get("retry-after")
        ? { "Retry-After": response.headers.get("retry-after")! }
        : {}),
      ...(response.headers.get("x-correlation-id")
        ? { "x-correlation-id": response.headers.get("x-correlation-id")! }
        : {}),
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "sessions.manage_self",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  try {
    const response = await callAdminApiAs(
      auth.principal,
      "/api/admin/team/mfa",
      { timeoutMs: 8_000 },
    );
    return proxyResponse(response, await response.text());
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "mfa_unavailable",
        message: "Team security status is temporarily unavailable.",
        retryable: true,
      },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
}
