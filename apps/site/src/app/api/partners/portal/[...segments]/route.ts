import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callPartnerApi, callPartnerPublicApi } from "@/app/partners/lib/api";

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "idempotency-key",
  "if-match",
  "x-correlation-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "etag",
  "location",
  "retry-after",
  "x-next-cursor",
  "x-location-directory-etag",
  "idempotency-replayed",
] as const;

function resolveCorrelationId(request: NextRequest): string {
  const requested = request.headers.get("x-correlation-id")?.trim() ?? "";
  if (SAFE_CORRELATION_ID.test(requested)) return requested;
  return `portal_${crypto.randomUUID().replace(/-/gu, "")}`;
}

function proxyError(
  correlationId: string,
  status: number,
  error: string,
  message: string,
  extraHeaders?: HeadersInit,
): NextResponse {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "x-correlation-id": correlationId,
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return NextResponse.json(
    {
      ok: false,
      error,
      message,
      correlationId,
      ...(status >= 500 ? { retryable: true } : {}),
    },
    {
      status,
      headers,
    },
  );
}

function mutationOriginIsAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin) return origin === request.nextUrl.origin;
  return fetchSite === "same-origin" || fetchSite === "none";
}

async function readBoundedBody(
  request: NextRequest,
): Promise<ArrayBuffer | null> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_JSON_BODY_BYTES
  ) {
    return null;
  }

  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new ArrayBuffer(length);
  const bytes = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function proxyPartnerPortalRequest(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  const correlationId = resolveCorrelationId(request);
  const method = request.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return proxyError(
      correlationId,
      405,
      "method_not_allowed",
      "This request method is not supported.",
      { Allow: "GET, POST, PUT, PATCH, DELETE" },
    );
  }
  if (method !== "GET" && !mutationOriginIsAllowed(request)) {
    return proxyError(
      correlationId,
      403,
      "forbidden",
      "The request origin could not be verified.",
    );
  }

  const { segments } = await context.params;
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.length > 8 ||
    segments.some((segment) => !SAFE_SEGMENT.test(segment))
  ) {
    return proxyError(
      correlationId,
      400,
      "invalid_request",
      "The portal path is invalid.",
    );
  }

  let body: ArrayBuffer | undefined;
  if (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  ) {
    const parsed = await readBoundedBody(request);
    if (!parsed) {
      return proxyError(
        correlationId,
        413,
        "invalid_body",
        "The request body is too large.",
      );
    }
    body = parsed.byteLength > 0 ? parsed : undefined;
  }

  const requestHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  requestHeaders.set("x-correlation-id", correlationId);
  // The API connection can use internal HTTP even when the browser-facing
  // portal request is HTTPS. Set this from Next's parsed request URL only;
  // never relay an untrusted incoming forwarding header.
  requestHeaders.set(
    "X-Forwarded-Proto",
    request.nextUrl.protocol === "https:" ? "https" : "http",
  );
  if (method !== "GET") requestHeaders.set("Origin", request.nextUrl.origin);
  const query = request.nextUrl.search;
  const joinedPath = segments.join("/");
  const publicAccessRequest =
    (method === "GET" && joinedPath === "access-applications/requirements") ||
    (method === "POST" && joinedPath === "access-applications");
  const upstreamCall = publicAccessRequest
    ? callPartnerPublicApi
    : callPartnerApi;
  const upstream = await upstreamCall(
    `/api/portal/v2/${segments.map(encodeURIComponent).join("/")}${query}`,
    {
      method,
      ...(body ? { body } : {}),
      headers: requestHeaders,
      timeoutMs: 45_000,
    },
  ).catch(() => null);

  if (!upstream) {
    console.warn("[partner.portal.proxy] upstream_unavailable", {
      correlationId,
    });
    return proxyError(
      correlationId,
      503,
      "service_unavailable",
      "The partner service is temporarily unavailable. Try again shortly.",
    );
  }

  const responseHeaders = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "x-correlation-id": correlationId,
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxyPartnerPortalRequest;
export const POST = proxyPartnerPortalRequest;
export const PUT = proxyPartnerPortalRequest;
export const PATCH = proxyPartnerPortalRequest;
export const DELETE = proxyPartnerPortalRequest;
