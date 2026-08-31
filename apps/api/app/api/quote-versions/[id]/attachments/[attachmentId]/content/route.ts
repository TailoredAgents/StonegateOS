import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { loadQuoteV2AttachmentContent } from "@/lib/quote-v2-attachment-service";
import { requirePermission } from "@/lib/permissions";
import { TeamMutationFailure } from "@/lib/team-mutation";
import { isAdminRequest } from "../../../../../web/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id?: string; attachmentId?: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;
  if (!isQuoteV2FeatureEnabled("staff")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { id: versionId = "", attachmentId = "" } = await context.params;
  if (!UUID_PATTERN.test(versionId) || !UUID_PATTERN.test(attachmentId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const content = await loadQuoteV2AttachmentContent(getDb(), {
      versionId,
      attachmentId,
      customerVisibleOnly: false,
    });
    const responseBytes = new Uint8Array(content.bytes.byteLength);
    responseBytes.set(content.bytes);
    return new Response(responseBytes, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": content.contentType,
        "Content-Length": String(content.bytes.byteLength),
        "Content-Disposition": content.contentDisposition,
        "Content-Security-Policy": "sandbox",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ETag: `"sha256-${content.sha256}"`,
      },
    });
  } catch (error) {
    const status = error instanceof TeamMutationFailure ? error.status : 503;
    return NextResponse.json(
      { error: status === 404 ? "not_found" : "attachment_unavailable" },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
