import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

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
  request: NextRequest,
  context: { params: Promise<{ expenseId: string }> }
): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  if (!hasOwner && !hasCrew) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { expenseId } = await context.params;
  if (!expenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApi(`/api/admin/expenses/${encodeURIComponent(expenseId)}/receipt`);
  if (!apiResponse.ok) {
    return NextResponse.json({ error: "not_found" }, { status: apiResponse.status });
  }

  const payload = (await apiResponse.json()) as {
    ok?: boolean;
    filename?: string;
    contentType?: string;
    dataUrl?: string;
  };

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
