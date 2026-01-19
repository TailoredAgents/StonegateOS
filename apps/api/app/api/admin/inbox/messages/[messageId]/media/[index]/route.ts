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

function isAllowedPublicMediaUrl(value: string, request: NextRequest): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();
    const requestHost = request.nextUrl.hostname.toLowerCase();
    if (host === requestHost) return true;

    const envBase = (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").trim();
    if (envBase) {
      const withScheme = /^https?:\/\//i.test(envBase) ? envBase : `https://${envBase}`;
      try {
        const envUrl = new URL(withScheme);
        if (envUrl.hostname.toLowerCase() === host) return true;
      } catch {
        // ignore
      }
    }

    if (host.endsWith("fbcdn.net") || host.endsWith("fbsbx.com")) return true;

    return false;
  } catch {
    return false;
  }
}

async function resolveMedia(request: NextRequest, context: RouteContext): Promise<{
  mediaUrl: string;
  provider: string | null;
} | Response> {
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

  return { mediaUrl, provider: row.provider ?? null };
}

function readTwilioAuth(): string | null {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  if (!sid || !token) return null;
  return Buffer.from(`${sid}:${token}`).toString("base64");
}

async function fetchTwilioHead(mediaUrl: string, auth: string): Promise<Response> {
  const headResponse = await fetch(mediaUrl, {
    method: "HEAD",
    headers: { Authorization: `Basic ${auth}` }
  }).catch(() => null);

  const response = headResponse?.ok
    ? headResponse
    : await fetch(mediaUrl, {
        method: "GET",
        headers: { Authorization: `Basic ${auth}`, Range: "bytes=0-0" }
      }).catch(() => null);

  if (!response?.ok) {
    const status = response?.status ?? 502;
    const text = response ? await response.text().catch(() => "") : "";
    return NextResponse.json(
      { error: "media_fetch_failed", detail: `twilio:${status}:${text}` },
      { status: 502 }
    );
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = response.headers.get("content-length");

  try {
    await response.arrayBuffer();
  } catch {
    // ignore
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      ...(contentLength ? { "Content-Length": contentLength } : {}),
      "Cache-Control": "private, max-age=60"
    }
  });
}

async function fetchPublicHead(mediaUrl: string): Promise<Response> {
  const headResponse = await fetch(mediaUrl, { method: "HEAD" }).catch(() => null);

  const response = headResponse?.ok
    ? headResponse
    : await fetch(mediaUrl, {
        method: "GET",
        headers: { Range: "bytes=0-0" }
      }).catch(() => null);

  if (!response?.ok) {
    const status = response?.status ?? 502;
    const text = response ? await response.text().catch(() => "") : "";
    return NextResponse.json({ error: "media_fetch_failed", detail: `public:${status}:${text}` }, { status: 502 });
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = response.headers.get("content-length");

  try {
    await response.arrayBuffer();
  } catch {
    // ignore
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      ...(contentLength ? { "Content-Length": contentLength } : {}),
      "Cache-Control": "private, max-age=60"
    }
  });
}

export async function HEAD(request: NextRequest, context: RouteContext): Promise<Response> {
  const resolved = await resolveMedia(request, context);
  if (resolved instanceof Response) return resolved;

  const { mediaUrl, provider } = resolved;
  if (provider === "twilio" && isAllowedTwilioMediaUrl(mediaUrl)) {
    const auth = readTwilioAuth();
    if (!auth) {
      return NextResponse.json({ error: "twilio_not_configured" }, { status: 500 });
    }

    return fetchTwilioHead(mediaUrl, auth);
  }
  if (isAllowedPublicMediaUrl(mediaUrl, request)) {
    return fetchPublicHead(mediaUrl);
  }
  return NextResponse.json({ error: "media_provider_unsupported" }, { status: 400 });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const resolved = await resolveMedia(request, context);
  if (resolved instanceof Response) return resolved;

  const { mediaUrl, provider } = resolved;
  if (provider === "twilio" && isAllowedTwilioMediaUrl(mediaUrl)) {
    const auth = readTwilioAuth();
    if (!auth) {
      return NextResponse.json({ error: "twilio_not_configured" }, { status: 500 });
    }

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
  if (isAllowedPublicMediaUrl(mediaUrl, request)) {
    const upstream = await fetch(mediaUrl, { method: "GET" });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: "media_fetch_failed", detail: `public:${upstream.status}:${text}` },
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
  return NextResponse.json({ error: "media_provider_unsupported" }, { status: 400 });
}
