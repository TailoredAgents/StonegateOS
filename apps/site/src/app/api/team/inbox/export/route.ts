import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);

  if (!hasOwner && !hasCrew) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.toString();
  const upstream = await callAdminApi(`/api/admin/inbox/export/jsonl${query ? `?${query}` : ""}`, {
    method: "GET",
    headers: {
      Accept: "application/x-ndjson"
    }
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return new NextResponse(text || "export_failed", {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/x-ndjson; charset=utf-8";
  const contentDisposition = upstream.headers.get("content-disposition") ?? "attachment; filename=\"stonegate-conversations.jsonl\"";

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "no-store"
    }
  });
}

