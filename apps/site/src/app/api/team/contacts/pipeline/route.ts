import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

export async function POST(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const returnJson = wantsJson(request);
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);

  if (!hasOwner && !hasCrew) {
    const redirectTo = getSafeRedirectUrl(request, "/team?tab=contacts");
    return returnJson
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.redirect(redirectTo, 303);
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const contactId = typeof record["contactId"] === "string" ? record["contactId"].trim() : "";
  const stage = typeof record["stage"] === "string" ? record["stage"].trim() : "";

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }
  if (!stage) {
    return NextResponse.json({ error: "stage_required" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/crm/pipeline/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ stage })
  });

  if (!apiResponse.ok) {
    let message = "Unable to update stage";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    return NextResponse.json({ error: "pipeline_update_failed", message }, { status: apiResponse.status });
  }

  const data = (await apiResponse.json().catch(() => null)) as unknown;
  return NextResponse.json({ ok: true, pipeline: data }, { status: 200 });
}

