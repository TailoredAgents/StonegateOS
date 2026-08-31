import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";
import { quotePublicProxyNetworkHeaders } from "@/lib/quote-public-proxy-network";

export const dynamic = "force-dynamic";

const API_BASE_URL = (
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001"
).replace(/\/$/u, "");
// V2 capabilities are at least 32 characters; 24-character legacy share links
// remain proxyable during the additive migration and receive the same limiter.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/u;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const MAXIMUM_BODY_BYTES = 64 * 1024;
const GET_TARGETS = new Set(["", "availability", "checkout", "pdf"]);
const POST_TARGETS = new Set([
  "",
  "changes",
  "refresh",
  "engagement",
  "hold",
  "checkout",
  "book",
]);

function publicProxyHeaders(correlationId?: string | null): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
  });
  if (correlationId && CORRELATION_PATTERN.test(correlationId)) {
    headers.set("x-correlation-id", correlationId);
  }
  return headers;
}

function proxyError(status: number, code: string, message: string) {
  const correlationId = crypto.randomUUID();
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: status >= 500,
      correlationId,
    },
    { status, headers: publicProxyHeaders(correlationId) },
  );
}

function resolvedTarget(
  request: NextRequest,
  token: string,
  segments: readonly string[],
): URL | null {
  const action = segments.join("/");
  const attachmentTarget = /^attachments\/[0-9a-f-]{36}$/iu.test(action);
  const supported =
    request.method === "GET"
      ? GET_TARGETS.has(action) || attachmentTarget
      : request.method === "POST"
        ? POST_TARGETS.has(action)
        : false;
  if (!supported || !TOKEN_PATTERN.test(token)) return null;
  const path = `/api/public/quotes/${encodeURIComponent(token)}${
    action ? `/${action}` : ""
  }`;
  const url = new URL(path, API_BASE_URL);
  if (request.method === "GET") {
    for (const [key, value] of request.nextUrl.searchParams) {
      if (
        action === "checkout" &&
        ["attemptId", "quoteId", "versionId", "responseId"].includes(key)
      ) {
        url.searchParams.append(key, value);
      }
    }
  }
  return url;
}

async function proxy(
  request: NextRequest,
  context: {
    params: Promise<{ token: string; segments?: string[] }>;
  },
): Promise<Response> {
  const { token, segments = [] } = await context.params;
  const target = resolvedTarget(request, token, segments);
  if (!target) {
    return proxyError(
      404,
      "not_found",
      "This proposal operation was not found.",
    );
  }
  const correlationId = request.headers.get("x-correlation-id")?.trim() ?? "";
  const upstreamHeaders = new Headers();
  if (CORRELATION_PATTERN.test(correlationId)) {
    upstreamHeaders.set("x-correlation-id", correlationId);
  }
  try {
    for (const [name, value] of Object.entries(
      quotePublicProxyNetworkHeaders(request, target),
    )) {
      upstreamHeaders.set(name, value);
    }
  } catch {
    return proxyError(
      503,
      "provider_unavailable",
      "The proposal service is temporarily unavailable.",
    );
  }
  let body: string | undefined;
  if (request.method === "POST") {
    if (request.nextUrl.search.length > 0) {
      return proxyError(
        422,
        "invalid",
        "Proposal actions do not accept query parameters.",
      );
    }
    const contentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
      return proxyError(415, "invalid", "Proposal actions require JSON.");
    }
    const contentEncoding =
      request.headers.get("content-encoding")?.trim() ?? "";
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      return proxyError(
        415,
        "invalid",
        "Compressed proposal actions are not accepted.",
      );
    }
    const idempotencyKey =
      request.headers.get("idempotency-key")?.normalize("NFKC").trim() ?? "";
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      return proxyError(
        422,
        "invalid",
        "Refresh the proposal before trying that action again.",
      );
    }
    try {
      const bytes = await readBoundedRequestBytes(request, MAXIMUM_BODY_BYTES);
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      const tooLarge =
        error instanceof BoundedRequestBodyError &&
        error.reason === "too_large";
      return proxyError(
        tooLarge ? 413 : 422,
        "invalid",
        tooLarge
          ? "The proposal action is too large."
          : "The proposal action could not be read.",
      );
    }
    upstreamHeaders.set("Content-Type", "application/json");
    upstreamHeaders.set("Idempotency-Key", idempotencyKey);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    return proxyError(
      503,
      "provider_unavailable",
      "The proposal service is temporarily unavailable.",
    );
  }
  const headers = publicProxyHeaders(
    upstream.headers.get("x-correlation-id") ?? correlationId,
  );
  for (const name of [
    "content-type",
    "content-disposition",
    "content-length",
    "retry-after",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export const GET = proxy;
export const POST = proxy;
