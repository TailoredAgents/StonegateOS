import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { diagnoseFacebookMessengerLookup } from "@/lib/facebook-webhooks";
import { isAdminRequest } from "../../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }

  const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
  const senderId = typeof body["senderId"] === "string" ? body["senderId"].trim() : "";
  const pageId = typeof body["pageId"] === "string" ? body["pageId"].trim() : null;
  const appId = typeof body["appId"] === "string" ? body["appId"].trim() : null;

  if (!senderId) {
    return NextResponse.json({ error: "sender_id_required" }, { status: 400 });
  }

  try {
    const diagnostics = await diagnoseFacebookMessengerLookup({ senderId, pageId, appId });
    return NextResponse.json({ ok: true, diagnostics });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: "facebook_diagnostics_failed", details: String(error) },
      { status: 500 }
    );
  }
}
