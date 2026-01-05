import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, conversationMessages } from "@/db";
import { isAdminRequest } from "../../../../../../web/admin";
import { requirePermission } from "@/lib/permissions";

type RouteContext = {
  params: Promise<{ messageId?: string; index?: string }>;
};

function parseIndex(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function isAllowedTwilioMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.twilio.com";
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { messageId, index } = await context.params;
  const mediaIndex = parseIndex(index);
  if (!messageId) {
    return NextResponse.json({ error: "message_id_required" }, { status: 400 });
  }
  if (mediaIndex === null) {
    return NextResponse.json({ error: "index_required" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: conversationMessages.id,
      provider: conversationMessages.provider,
      mediaUrls: conversationMessages.mediaUrls
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  const mediaUrls = row.mediaUrls ?? [];
  const mediaUrl = mediaUrls[mediaIndex];
  if (!mediaUrl) {
    return NextResponse.json({ error: "media_not_found" }, { status: 404 });
  }

  if (row.provider !== "twilio" || !isAllowedTwilioMediaUrl(mediaUrl)) {
    return NextResponse.json({ error: "media_provider_unsupported" }, { status: 400 });
  }

  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  if (!sid || !token) {
    return NextResponse.json({ error: "twilio_not_configured" }, { status: 500 });
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const upstream = await fetch(mediaUrl, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` }
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "media_fetch_failed", detail: `twilio:${upstream.status}:${text}` },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const bytes = await upstream.arrayBuffer();

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=60"
    }
  });
}

