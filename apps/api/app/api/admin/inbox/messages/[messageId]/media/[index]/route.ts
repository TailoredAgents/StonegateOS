import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { conversationMessages, conversationThreads, getDb } from "@/db";
import { isAdminRequest } from "../../../../../../web/admin";
import {
  BrowserMediaError,
  buildSafeBrowserMediaResponse,
  readBoundedBrowserMedia,
} from "@/lib/browser-media";
import { requirePermission } from "@/lib/permissions";
import { genericInboxThreadScopeCondition } from "@/lib/inbox-staff-scope";
import { fetchTwilioProviderMedia } from "@/lib/twilio-provider";

type RouteContext = {
  params: Promise<{ messageId?: string; index?: string }>;
};

type ResolvedMedia = {
  mediaUrl: string;
  provider: string | null;
};

type LoadedMedia = {
  bytes: Uint8Array;
  declaredContentType: string | null;
  filename: string | null;
};

const PUBLIC_MEDIA_TIMEOUT_MS = 10_000;
const MAX_PUBLIC_MEDIA_REDIRECTS = 3;

function parseIndex(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function isAllowedPublicMediaUrl(value: string, request: NextRequest): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      return false;
    }

    const host = url.hostname.toLowerCase();
    const requestHost = request.nextUrl.hostname.toLowerCase();
    if (host === requestHost) return true;

    const envBase = (
      process.env["API_BASE_URL"] ??
      process.env["NEXT_PUBLIC_API_BASE_URL"] ??
      ""
    ).trim();
    if (envBase) {
      const withScheme = /^https?:\/\//iu.test(envBase)
        ? envBase
        : `https://${envBase}`;
      try {
        const envUrl = new URL(withScheme);
        if (
          envUrl.protocol === "https:" &&
          envUrl.hostname.toLowerCase() === host
        ) {
          return true;
        }
      } catch {
        // Invalid deployment configuration never expands the allowlist.
      }
    }

    return (
      host === "fbcdn.net" ||
      host.endsWith(".fbcdn.net") ||
      host === "fbsbx.com" ||
      host.endsWith(".fbsbx.com")
    );
  } catch {
    return false;
  }
}

async function resolveMedia(
  request: NextRequest,
  context: RouteContext,
): Promise<ResolvedMedia | Response> {
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

  const [row] = await getDb()
    .select({
      provider: conversationMessages.provider,
      mediaUrls: conversationMessages.mediaUrls,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .where(
      and(
        eq(conversationMessages.id, messageId),
        genericInboxThreadScopeCondition(),
      ),
    )
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }
  const mediaUrl = (row.mediaUrls ?? [])[mediaIndex];
  if (!mediaUrl) {
    return NextResponse.json({ error: "media_not_found" }, { status: 404 });
  }
  return { mediaUrl, provider: row.provider ?? null };
}

async function fetchPublicMedia(
  initialUrl: string,
  request: NextRequest,
): Promise<LoadedMedia> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_MEDIA_TIMEOUT_MS);
  timeout.unref?.();
  let current = initialUrl;
  try {
    for (
      let redirectCount = 0;
      redirectCount <= MAX_PUBLIC_MEDIA_REDIRECTS;
      redirectCount += 1
    ) {
      if (!isAllowedPublicMediaUrl(current, request)) {
        throw new Error("public_media_url_forbidden");
      }
      const upstream = await fetch(current, {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get("location");
        await upstream.body?.cancel().catch(() => undefined);
        if (!location || redirectCount === MAX_PUBLIC_MEDIA_REDIRECTS) {
          throw new Error("public_media_redirect_invalid");
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error("public_media_fetch_failed");
      }
      return {
        bytes: await readBoundedBrowserMedia(upstream),
        declaredContentType: upstream.headers.get("content-type"),
        filename: new URL(current).pathname.split("/").at(-1) || null,
      };
    }
    throw new Error("public_media_redirect_invalid");
  } finally {
    clearTimeout(timeout);
  }
}

function providerFailureResponse(input: {
  code: string;
  status: number | null;
}): Response {
  if (input.code === "response_too_large") {
    return NextResponse.json({ error: "media_too_large" }, { status: 413 });
  }
  if (input.code === "invalid_input") {
    return NextResponse.json(
      { error: "media_provider_unsupported" },
      { status: 400 },
    );
  }
  if (
    input.code === "not_configured" ||
    input.code === "invalid_configuration"
  ) {
    return NextResponse.json(
      { error: "media_provider_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: input.status === 404 ? "media_not_found" : "media_fetch_failed" },
    { status: input.status === 404 ? 404 : 502 },
  );
}

async function serveResolvedMedia(
  request: NextRequest,
  resolved: ResolvedMedia,
  headOnly: boolean,
): Promise<Response> {
  try {
    let loaded: LoadedMedia;
    if (resolved.provider === "twilio") {
      const result = await fetchTwilioProviderMedia(resolved.mediaUrl);
      if (!result.ok) return providerFailureResponse(result);
      loaded = {
        bytes: result.buffer,
        declaredContentType: result.declaredContentType,
        filename: result.filename,
      };
    } else {
      if (!isAllowedPublicMediaUrl(resolved.mediaUrl, request)) {
        return NextResponse.json(
          { error: "media_provider_unsupported" },
          { status: 400 },
        );
      }
      loaded = await fetchPublicMedia(resolved.mediaUrl, request);
    }
    return buildSafeBrowserMediaResponse({ ...loaded, headOnly });
  } catch (error) {
    if (error instanceof BrowserMediaError && error.status === 413) {
      return NextResponse.json({ error: "media_too_large" }, { status: 413 });
    }
    return NextResponse.json({ error: "media_fetch_failed" }, { status: 502 });
  }
}

export async function HEAD(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const resolved = await resolveMedia(request, context);
  if (resolved instanceof Response) return resolved;
  return serveResolvedMedia(request, resolved, true);
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const resolved = await resolveMedia(request, context);
  if (resolved instanceof Response) return resolved;
  return serveResolvedMedia(request, resolved, false);
}
