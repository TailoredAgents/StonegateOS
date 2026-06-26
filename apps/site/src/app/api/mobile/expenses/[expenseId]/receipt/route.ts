import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "../../../../../mobile/lib/session";

export const dynamic = "force-dynamic";

function parseDataUrl(dataUrl: string): { contentType: string; buffer: Buffer } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const contentType = match[1] || "application/octet-stream";
  const base64 = match[2] || "";
  return { contentType, buffer: Buffer.from(base64, "base64") };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "receipt";
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ expenseId: string }> }
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hasMobilePermission(session.teamMember.permissions, "expenses.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { expenseId } = await context.params;
  const normalizedExpenseId = expenseId.trim();
  if (!normalizedExpenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/expenses/${encodeURIComponent(normalizedExpenseId)}/receipt`, {
    method: "GET"
  });
  if (!apiResponse.ok) {
    return NextResponse.json({ error: "not_found" }, { status: apiResponse.status });
  }

  const payload = (await apiResponse.json().catch(() => null)) as {
    ok?: boolean;
    filename?: string;
    contentType?: string;
    dataUrl?: string;
  } | null;

  if (!payload?.dataUrl) {
    return NextResponse.json({ error: "no_receipt" }, { status: 404 });
  }

  const parsed = parseDataUrl(payload.dataUrl);
  if (!parsed) {
    return NextResponse.json({ error: "invalid_receipt" }, { status: 500 });
  }

  const filename = sanitizeFilename(payload.filename ?? "receipt");
  const contentType = payload.contentType ?? parsed.contentType;
  const arrayBuffer = new ArrayBuffer(parsed.buffer.byteLength);
  new Uint8Array(arrayBuffer).set(parsed.buffer);
  const blob = new Blob([arrayBuffer], { type: contentType });
  return new Response(blob, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename=\"${filename}\"`,
      "Cache-Control": "private, max-age=60"
    }
  });
}
