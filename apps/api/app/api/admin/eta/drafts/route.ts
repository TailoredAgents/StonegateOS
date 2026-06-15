import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { listEtaDrafts } from "@/lib/eta-agent";
import { isAdminRequest } from "../../../web/admin";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const status = request.nextUrl.searchParams.get("status")?.trim() || "draft";
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? 25);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
  const drafts = await listEtaDrafts(status, limit);
  return NextResponse.json({ ok: true, drafts });
}
