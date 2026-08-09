import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "audit.export",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const query = request.nextUrl.searchParams.toString();
  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/audit/export${query ? `?${query}` : ""}`,
    {
      method: "GET",
      headers: {
        Accept: "application/x-ndjson",
        "x-request-id": crypto.randomUUID(),
      },
    },
  );

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return new NextResponse(body || "audit_export_failed", {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ??
          "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ??
        "application/x-ndjson; charset=utf-8",
      "Content-Disposition":
        upstream.headers.get("content-disposition") ??
        'attachment; filename="stonegate-audit.jsonl"',
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
