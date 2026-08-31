import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { TeamPermission } from "@myst-os/sdk";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";
import { callAdminMutationWithSafeReplay } from "@/app/team/lib/team-mutation-transport";
import { callAdminApiAs } from "@/app/team/lib/api";
import { isQuoteV2StaffFeatureEnabled } from "@/app/team/lib/quote-v2-staff-feature";
import { normalizeQuoteV2IfMatchRevision } from "@/app/team/lib/quote-v2-proxy-contract";

export const dynamic = "force-dynamic";

const MAXIMUM_BODY_BYTES = 256 * 1024;
const MAXIMUM_ATTACHMENT_BODY_BYTES = 10 * 1024 * 1024 + 256 * 1024;
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const REVISION_PATTERN = /^[1-9]\d{0,9}$/u;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type SupportedMethod = "POST" | "PATCH" | "DELETE";
type ProxyTarget = {
  method: SupportedMethod;
  upstreamPath: string;
  permission: TeamPermission;
  requiresRevision: boolean;
  safeReplay: boolean;
  allowsOneTimeCapability?: boolean;
  bodyType?: "json" | "multipart";
};

type ReadProxyTarget = {
  upstreamPath: string;
  acceptsListQuery: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const LIST_QUERY_KEYS = new Set([
  "cursor",
  "limit",
  "bucket",
  "search",
  "ownerId",
  "sort",
]);

function quoteV2ProxyError(
  status: number,
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    correlationId?: string | null;
    fieldErrors?: Record<string, string>;
  } = {},
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: options.retryable ?? false,
      correlationId: options.correlationId ?? crypto.randomUUID(),
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    },
    {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

function resolveTarget(
  method: string,
  segments: readonly string[],
): ProxyTarget | null {
  const path = segments.join("/");
  if (method === "POST" && path === "quotes") {
    return {
      method: "POST",
      upstreamPath: "/api/quotes",
      permission: "quotes.write",
      requiresRevision: false,
      safeReplay: true,
    };
  }
  if (method === "POST" && path === "contacts") {
    return {
      method: "POST",
      upstreamPath: "/api/admin/contacts",
      permission: "contacts.write",
      requiresRevision: false,
      safeReplay: false,
    };
  }
  let match = new RegExp(`^quotes/(${UUID})/draft$`, "iu").exec(path);
  if (method === "PATCH" && match?.[1]) {
    return {
      method: "PATCH",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/draft`,
      permission: "quotes.write",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quotes/(${UUID})/finalize$`, "iu").exec(path);
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/finalize`,
      permission: "quotes.send",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quotes/(${UUID})/revisions$`, "iu").exec(path);
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/revisions`,
      permission: "quotes.update",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quotes/(${UUID})/decisions$`, "iu").exec(path);
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/decisions`,
      permission: "quotes.update",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(
    `^quotes/(${UUID})/change-requests/(${UUID})/resolve$`,
    "iu",
  ).exec(path);
  if (method === "POST" && match?.[1] && match[2]) {
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/change-requests/${encodeURIComponent(match[2])}/resolve`,
      permission: "quotes.update",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quotes/(${UUID})/(void|archive)$`, "iu").exec(path);
  if (method === "POST" && match?.[1] && match[2]) {
    const action = match[2].toLowerCase();
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/${action}`,
      permission: "quotes.update",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quote-versions/(${UUID})/issue$`, "iu").exec(path);
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/issue`,
      permission: "quotes.send",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quote-versions/(${UUID})/attachments$`, "iu").exec(path);
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/attachments`,
      permission: "quotes.write",
      requiresRevision: true,
      safeReplay: true,
      bodyType: "multipart",
    };
  }
  match = new RegExp(
    `^quote-versions/(${UUID})/attachments/(${UUID})$`,
    "iu",
  ).exec(path);
  if (method === "DELETE" && match?.[1] && match[2]) {
    return {
      method: "DELETE",
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/attachments/${encodeURIComponent(match[2])}`,
      permission: "quotes.write",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(`^quote-versions/(${UUID})/send-attempts$`, "iu").exec(
    path,
  );
  if (method === "POST" && match?.[1]) {
    return {
      method: "POST",
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/send-attempts`,
      permission: "quotes.send",
      requiresRevision: true,
      safeReplay: true,
    };
  }
  match = new RegExp(
    `^quotes/(${UUID})/capabilities/(${UUID})/(replace|revoke)$`,
    "iu",
  ).exec(path);
  if (method === "POST" && match?.[1] && match[2] && match[3]) {
    const action = match[3].toLowerCase();
    return {
      method: "POST",
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}/capabilities/${encodeURIComponent(match[2])}/${action}`,
      permission: "quotes.send",
      requiresRevision: true,
      safeReplay: true,
      allowsOneTimeCapability: action === "replace",
    };
  }
  return null;
}

function resolveReadTarget(
  segments: readonly string[],
): ReadProxyTarget | null {
  const path = segments.join("/");
  if (path === "quotes") {
    return { upstreamPath: "/api/quotes", acceptsListQuery: true };
  }
  let match = new RegExp(`^quotes/(${UUID})$`, "iu").exec(path);
  if (match?.[1]) {
    return {
      upstreamPath: `/api/quotes/${encodeURIComponent(match[1])}`,
      acceptsListQuery: false,
    };
  }
  match = new RegExp(`^quote-versions/(${UUID})/preview$`, "iu").exec(path);
  if (match?.[1]) {
    return {
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/preview`,
      acceptsListQuery: false,
    };
  }
  match = new RegExp(`^quote-versions/(${UUID})/attachments$`, "iu").exec(path);
  if (match?.[1]) {
    return {
      upstreamPath: `/api/quote-versions/${encodeURIComponent(match[1])}/attachments`,
      acceptsListQuery: false,
    };
  }
  return null;
}

function containsCustomerSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCustomerSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => {
      const normalized = key.replace(/[^a-z]/giu, "").toLowerCase();
      if (
        normalized === "token" ||
        normalized === "sharetoken" ||
        normalized === "shareurl" ||
        normalized === "actionurl" ||
        normalized === "proposalurl" ||
        normalized === "rawtoken" ||
        normalized === "capabilitytoken" ||
        normalized === "customerurl" ||
        normalized === "customeractionurl"
      ) {
        return child !== null && child !== undefined;
      }
      if (normalized === "onetimelink" || normalized === "onetimelinks") {
        return Array.isArray(child) ? child.length > 0 : child != null;
      }
      return containsCustomerSecret(child);
    },
  );
}

function isExpectedOneTimeCapabilityResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const data = isRecord(value["data"]) ? value["data"] : null;
  const oneTimeLink =
    data && isRecord(data["oneTimeLink"]) ? data["oneTimeLink"] : null;
  if (
    value["ok"] !== true ||
    !data ||
    data["oneTimeLinkAvailable"] !== true ||
    !oneTimeLink ||
    oneTimeLink["recipientRole"] !== "signer" ||
    typeof oneTimeLink["href"] !== "string"
  ) {
    return false;
  }
  try {
    const url = new URL(oneTimeLink["href"]);
    const token = url.pathname.match(
      /^\/quote\/([A-Za-z0-9_-]{40,512})$/u,
    )?.[1];
    if (
      !token ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && url.hostname !== "localhost")
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const dataWithoutLink = { ...data };
  delete dataWithoutLink["oneTimeLink"];
  const valueWithoutLink = { ...value, data: dataWithoutLink };
  return !containsCustomerSecret(valueWithoutLink);
}

async function proxyMutation(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  if (!isQuoteV2StaffFeatureEnabled()) {
    return quoteV2ProxyError(
      404,
      "not_found",
      "The Quote V2 staff workspace is not enabled for this deployment.",
    );
  }
  const { segments } = await context.params;
  const target = resolveTarget(request.method, segments);
  if (!target) {
    return quoteV2ProxyError(
      404,
      "not_found",
      "This quote operation is not available.",
    );
  }
  if (request.nextUrl.search.length > 0) {
    return quoteV2ProxyError(
      422,
      "invalid",
      "Quote mutations do not accept query parameters.",
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: target.permission,
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const rawContentType = request.headers.get("content-type") ?? "";
  const contentType = rawContentType.toLowerCase();
  const expectsMultipart = target.bodyType === "multipart";
  if (
    expectsMultipart
      ? !contentType.startsWith("multipart/form-data;")
      : !/^application\/json(?:\s*;|$)/u.test(contentType)
  ) {
    return quoteV2ProxyError(
      415,
      "invalid",
      expectsMultipart
        ? "Quote attachments require a multipart upload."
        : "Quote changes require a JSON request.",
    );
  }
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    return quoteV2ProxyError(
      415,
      "invalid",
      "Compressed quote mutations are not accepted.",
    );
  }
  const idempotencyKey =
    request.headers.get("idempotency-key")?.normalize("NFKC").trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return quoteV2ProxyError(
      422,
      "invalid",
      "A stable quote request key is required.",
      { fieldErrors: { idempotencyKey: "Keep this page open and retry." } },
    );
  }
  const expectedRevision = normalizeQuoteV2IfMatchRevision(
    request.headers.get("if-match"),
  );
  if (target.requiresRevision && !REVISION_PATTERN.test(expectedRevision)) {
    return quoteV2ProxyError(
      422,
      "invalid",
      "The current quote revision is required.",
      { fieldErrors: { revision: "Refresh the draft before retrying." } },
    );
  }

  let body: BodyInit;
  try {
    const bytes = await readBoundedRequestBytes(
      request,
      expectsMultipart ? MAXIMUM_ATTACHMENT_BODY_BYTES : MAXIMUM_BODY_BYTES,
    );
    if (expectsMultipart) {
      const copied = new Uint8Array(bytes.byteLength);
      copied.set(bytes);
      body = new Blob([copied], { type: rawContentType });
    } else {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const payload = JSON.parse(body) as unknown;
      if (
        containsCustomerSecret(payload) &&
        !(
          target.allowsOneTimeCapability &&
          isExpectedOneTimeCapabilityResponse(payload)
        )
      ) {
        return quoteV2ProxyError(
          422,
          "invalid",
          "Customer access secrets are not accepted by the staff quote bridge.",
        );
      }
    }
  } catch (error) {
    const tooLarge =
      error instanceof BoundedRequestBodyError && error.reason === "too_large";
    return quoteV2ProxyError(
      tooLarge ? 413 : 422,
      "invalid",
      tooLarge
        ? expectsMultipart
          ? "The attachment is larger than 10 MB."
          : "The quote draft is too large to save."
        : "The quote request is malformed.",
      { fieldErrors: { request: "Keep your entries and review the form." } },
    );
  }

  const correlationId = request.headers.get("x-correlation-id")?.trim() ?? "";
  const headers = new Headers({
    "Content-Type": expectsMultipart ? rawContentType : "application/json",
    "Idempotency-Key": idempotencyKey,
  });
  if (expectsMultipart && body instanceof Blob) {
    headers.set("Content-Length", String(body.size));
  }
  if (target.requiresRevision) headers.set("If-Match", expectedRevision);
  if (CORRELATION_PATTERN.test(correlationId)) {
    headers.set("x-correlation-id", correlationId);
  }

  try {
    const upstream = await (target.safeReplay
      ? callAdminMutationWithSafeReplay(auth.principal, target.upstreamPath, {
          method: target.method,
          headers,
          body,
          timeoutMs: expectsMultipart ? 60_000 : 25_000,
        })
      : callAdminApiAs(auth.principal, target.upstreamPath, {
          method: target.method,
          headers,
          body,
          timeoutMs: expectsMultipart ? 60_000 : 25_000,
        }));
    const payload = (await upstream.json().catch(() => null)) as unknown;
    if (containsCustomerSecret(payload)) {
      return quoteV2ProxyError(
        502,
        "internal",
        "The quote service returned an unsafe staff response. Nothing sensitive was forwarded.",
        {
          retryable: false,
          correlationId: upstream.headers.get("x-correlation-id"),
        },
      );
    }
    const responseHeaders = new Headers({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json",
    });
    for (const name of [
      "x-correlation-id",
      "idempotency-replayed",
      "retry-after",
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return NextResponse.json(payload, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return quoteV2ProxyError(
      504,
      "provider_unavailable",
      "The quote service did not confirm the operation. Keep this page open before retrying.",
      {
        retryable: true,
        correlationId: CORRELATION_PATTERN.test(correlationId)
          ? correlationId
          : null,
      },
    );
  }
}

async function proxyRead(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  if (!isQuoteV2StaffFeatureEnabled()) {
    return quoteV2ProxyError(
      404,
      "not_found",
      "The Quote V2 staff workspace is not enabled for this deployment.",
    );
  }
  const target = resolveReadTarget((await context.params).segments);
  if (!target) {
    return quoteV2ProxyError(
      404,
      "not_found",
      "This quote view is not available.",
    );
  }
  const auth = await requireTeamPrincipal(request, {
    permissions: "quotes.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const upstreamQuery = new URLSearchParams();
  if (target.acceptsListQuery) {
    upstreamQuery.set("engine", "v2");
    if (request.nextUrl.search.length > 2_048) {
      return quoteV2ProxyError(
        422,
        "invalid",
        "The quote filters are too long.",
      );
    }
    for (const key of request.nextUrl.searchParams.keys()) {
      if (
        !LIST_QUERY_KEYS.has(key) ||
        request.nextUrl.searchParams.getAll(key).length !== 1
      ) {
        return quoteV2ProxyError(
          422,
          "invalid",
          "Review the quote filters and return to the first page.",
          { fieldErrors: { [key]: "This filter is not supported." } },
        );
      }
      const value = request.nextUrl.searchParams.get(key);
      if (value !== null) upstreamQuery.set(key, value);
    }
  } else if (request.nextUrl.search.length > 0) {
    return quoteV2ProxyError(
      422,
      "invalid",
      "This quote view does not accept query parameters.",
    );
  }

  const correlationId = request.headers.get("x-correlation-id")?.trim() ?? "";
  const headers = new Headers();
  if (CORRELATION_PATTERN.test(correlationId)) {
    headers.set("x-correlation-id", correlationId);
  }
  const query = upstreamQuery.size > 0 ? `?${upstreamQuery.toString()}` : "";
  try {
    const upstream = await callAdminApiAs(
      auth.principal,
      `${target.upstreamPath}${query}`,
      { method: "GET", headers, timeoutMs: 25_000 },
    );
    const payload = (await upstream.json().catch(() => null)) as unknown;
    if (containsCustomerSecret(payload)) {
      return quoteV2ProxyError(
        502,
        "internal",
        "The quote service returned an unsafe staff response. Nothing sensitive was forwarded.",
        { correlationId: upstream.headers.get("x-correlation-id") },
      );
    }
    const responseHeaders = new Headers({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json",
    });
    for (const name of ["x-correlation-id", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return NextResponse.json(payload, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return quoteV2ProxyError(
      504,
      "provider_unavailable",
      "The quote service could not load this view. Try again shortly.",
      {
        retryable: true,
        correlationId: CORRELATION_PATTERN.test(correlationId)
          ? correlationId
          : null,
      },
    );
  }
}

export function GET(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  return proxyRead(request, context);
}

export function POST(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  return proxyMutation(request, context);
}

export function PATCH(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  return proxyMutation(request, context);
}

export function DELETE(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  return proxyMutation(request, context);
}
