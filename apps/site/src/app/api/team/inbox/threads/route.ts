import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "../../auth";
import { callAdminApi } from "@/app/team/lib/api";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, { returnJson: true, roles: ["owner", "office", "crew"] });
  if (!auth.ok) return auth.response;

  const params = new URLSearchParams();
  const input = request.nextUrl.searchParams;

  const passthroughKeys = ["q", "status", "channel", "contactId", "limit", "offset"] as const;
  for (const key of passthroughKeys) {
    const value = input.get(key);
    if (typeof value === "string" && value.trim().length) {
      params.set(key, value.trim());
    }
  }

  const res = await callAdminApi(`/api/admin/inbox/threads?${params.toString()}`, { method: "GET" }).catch(() => null);
  if (!res) return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });

  const bodyText = await res.text().catch(() => "");
  return new NextResponse(bodyText, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store"
    }
  });
}

