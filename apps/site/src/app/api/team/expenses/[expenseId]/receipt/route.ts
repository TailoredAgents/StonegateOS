import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

const SAFE_RECEIPT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function parseDataUrl(
  dataUrl: string,
): { contentType: string; buffer: Buffer } | null {
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
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "expenses.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const { expenseId } = await context.params;
  if (!expenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/admin/expenses/${encodeURIComponent(expenseId)}/receipt`,
  );
  if (!apiResponse.ok) {
    return NextResponse.json(
      { error: "not_found" },
      { status: apiResponse.status },
    );
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
  const reportedContentType = payload.contentType ?? parsed.contentType;
  const contentType =
    reportedContentType === parsed.contentType &&
    SAFE_RECEIPT_CONTENT_TYPES.has(parsed.contentType)
      ? parsed.contentType
      : "application/octet-stream";
  const arrayBuffer = new ArrayBuffer(parsed.buffer.byteLength);
  new Uint8Array(arrayBuffer).set(parsed.buffer);
  const blob = new Blob([arrayBuffer], { type: contentType });
  return new Response(blob, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
