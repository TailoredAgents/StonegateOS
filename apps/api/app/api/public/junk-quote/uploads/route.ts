import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { LRUCache } from "lru-cache";
import { MAX_APPOINTMENT_IMAGE_BYTES } from "@/lib/appointment-image";
import { arePublicQuoteMediaUploadsEnabled } from "@/lib/feature-flags";
import {
  buildPublicInstantQuoteMediaReferenceUrl,
  createPublicInstantQuoteMediaUpload,
  PublicQuoteMediaError,
  resolvePublicMediaApiBaseUrl,
} from "@/lib/public-instant-quote-media";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ??
  process.env["NEXT_PUBLIC_SITE_URL"] ??
  process.env["SITE_URL"] ??
  "*";

const MAX_FILES_PER_REQUEST = 10;
const MAX_REQUEST_BYTES =
  MAX_FILES_PER_REQUEST * MAX_APPOINTMENT_IMAGE_BYTES + 1024 * 1024;
const MAX_REQUESTS_PER_CLIENT_WINDOW = 6;
const MAX_REQUESTS_PER_INSTANCE_WINDOW = 30;
const MAX_CONCURRENT_UPLOAD_REQUESTS = 2;
const GLOBAL_RATE_LIMIT_KEY = "__all_public_quote_uploads__";
const uploadRateLimiter = new LRUCache<string, number>({
  max: 5_000,
  ttl: 10 * 60 * 1_000,
});
const activeUploadClients = new Set<string>();
let activeUploadRequests = 0;

function resolveUploadClientKey(request: NextRequest): string {
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const address =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    forwardedFor ||
    "unknown";
  return `client:${address.slice(0, 128)}`;
}

function isRateLimited(key: string): boolean {
  const clientCount = (uploadRateLimiter.get(key) ?? 0) + 1;
  const globalCount = (uploadRateLimiter.get(GLOBAL_RATE_LIMIT_KEY) ?? 0) + 1;
  uploadRateLimiter.set(key, clientCount);
  uploadRateLimiter.set(GLOBAL_RATE_LIMIT_KEY, globalCount);
  return (
    clientCount > MAX_REQUESTS_PER_CLIENT_WINDOW ||
    globalCount > MAX_REQUESTS_PER_INSTANCE_WINDOW
  );
}

function acquireUploadCapacity(clientKey: string): (() => void) | null {
  if (
    activeUploadRequests >= MAX_CONCURRENT_UPLOAD_REQUESTS ||
    activeUploadClients.has(clientKey)
  ) {
    return null;
  }
  activeUploadRequests += 1;
  activeUploadClients.add(clientKey);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploadRequests = Math.max(activeUploadRequests - 1, 0);
    activeUploadClients.delete(clientKey);
  };
}

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(
  response: NextResponse,
  requestOrigin: string | null,
): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(
  body: unknown,
  requestOrigin: string | null,
  init?: ResponseInit,
): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(
    new NextResponse(null, { status: 204 }),
    request.headers.get("origin"),
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (
    RAW_ALLOWED_ORIGINS !== "*" &&
    resolveOrigin(requestOrigin) !== (requestOrigin ?? "").replace(/\/+$/u, "")
  ) {
    return corsJson({ error: "forbidden_origin" }, requestOrigin, {
      status: 403,
    });
  }
  if (!arePublicQuoteMediaUploadsEnabled()) {
    return corsJson({ error: "media_writes_disabled" }, requestOrigin, {
      status: 503,
    });
  }
  const rawContentLength = request.headers.get("content-length")?.trim();
  if (!rawContentLength || !/^[1-9]\d*$/u.test(rawContentLength)) {
    return corsJson({ error: "content_length_required" }, requestOrigin, {
      status: 411,
    });
  }
  const declaredRequestBytes = Number(rawContentLength);
  if (
    !Number.isSafeInteger(declaredRequestBytes) ||
    declaredRequestBytes > MAX_REQUEST_BYTES
  ) {
    return corsJson({ error: "request_too_large" }, requestOrigin, {
      status: 413,
    });
  }
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return corsJson(
      { error: "content_encoding_not_supported" },
      requestOrigin,
      { status: 415 },
    );
  }
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data;")
  ) {
    return corsJson({ error: "multipart_form_data_required" }, requestOrigin, {
      status: 415,
    });
  }
  const clientKey = resolveUploadClientKey(request);
  if (isRateLimited(clientKey)) {
    return corsJson({ error: "rate_limited" }, requestOrigin, { status: 429 });
  }
  const releaseCapacity = acquireUploadCapacity(clientKey);
  if (!releaseCapacity) {
    return corsJson(
      { error: "upload_capacity_busy", retryAfterSeconds: 5 },
      requestOrigin,
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }

  try {
    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return corsJson({ error: "invalid_form_data" }, requestOrigin, {
        status: 400,
      });
    }

    const files = ["file", "files", "attachments"]
      .flatMap((key) => formData.getAll(key))
      .filter(
        (value): value is File => value instanceof File && value.size > 0,
      );

    if (files.length === 0) {
      return corsJson({ error: "files_required" }, requestOrigin, {
        status: 400,
      });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return corsJson({ error: "too_many_files" }, requestOrigin, {
        status: 400,
      });
    }

    const baseUrl = resolvePublicMediaApiBaseUrl(request.nextUrl.origin);
    if (!baseUrl) {
      return corsJson({ error: "public_api_base_url_missing" }, requestOrigin, {
        status: 500,
      });
    }

    const uploads: { id: string; url: string }[] = [];

    for (const file of files) {
      const contentType =
        typeof file.type === "string" && file.type.trim().length > 0
          ? file.type.trim()
          : "";
      if (!contentType) {
        return corsJson(
          {
            error: "unsupported_content_type",
            detail: contentType || null,
          },
          requestOrigin,
          { status: 400 },
        );
      }
      if (file.size <= 0) {
        return corsJson({ error: "empty_file" }, requestOrigin, {
          status: 400,
        });
      }
      if (file.size > MAX_APPOINTMENT_IMAGE_BYTES) {
        return corsJson({ error: "file_too_large" }, requestOrigin, {
          status: 400,
        });
      }

      try {
        const created = await createPublicInstantQuoteMediaUpload({
          bytes: Buffer.from(await file.arrayBuffer()),
          declaredContentType: contentType,
          originalFilename: file.name,
        });
        uploads.push({
          id: created.assetId,
          url: buildPublicInstantQuoteMediaReferenceUrl({
            baseUrl,
            assetId: created.assetId,
            token: created.token,
          }),
        });
      } catch (error) {
        if (error instanceof PublicQuoteMediaError) {
          return corsJson(
            { error: error.code, message: error.message },
            requestOrigin,
            { status: error.status },
          );
        }
        console.error("[junk-quote-upload] storage_failed", error);
        return corsJson({ error: "upload_failed" }, requestOrigin, {
          status: 500,
        });
      }
    }

    return corsJson({ ok: true, uploads }, requestOrigin);
  } finally {
    releaseCapacity();
  }
}
