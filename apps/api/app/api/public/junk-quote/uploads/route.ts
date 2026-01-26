import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb, inboxMediaUploads } from "@/db";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 4;
const DEFAULT_TTL_DAYS = 7;

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/u, "")).filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(response: NextResponse, requestOrigin: string | null): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, requestOrigin: string | null, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }), request.headers.get("origin"));
}

function resolvePublicApiBaseUrl(request: NextRequest): string | null {
  const raw = (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").trim();
  const fallback = request.nextUrl.origin;
  const candidates = [raw, fallback].filter((value) => value && value.trim().length > 0);

  for (const candidate of candidates) {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      const url = new URL(withScheme);
      const lowered = url.hostname.toLowerCase();
      const isLocalhost =
        lowered === "localhost" ||
        lowered === "0.0.0.0" ||
        lowered === "127.0.0.1" ||
        lowered.endsWith(".internal");
      if (process.env["NODE_ENV"] === "production" && isLocalhost) continue;
      return url.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }

  return null;
}

function sanitizeFilename(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 200);
}

function isAllowedContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.startsWith("image/");
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (RAW_ALLOWED_ORIGINS !== "*" && resolveOrigin(requestOrigin) !== (requestOrigin ?? "").replace(/\/+$/u, "")) {
    return corsJson({ error: "forbidden_origin" }, requestOrigin, { status: 403 });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return corsJson({ error: "invalid_form_data" }, requestOrigin, { status: 400 });
  }

  const files = ["file", "files", "attachments"]
    .flatMap((key) => formData.getAll(key))
    .filter((value): value is File => value instanceof File && value.size > 0);

  if (files.length === 0) {
    return corsJson({ error: "files_required" }, requestOrigin, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return corsJson({ error: "too_many_files" }, requestOrigin, { status: 400 });
  }

  const baseUrl = resolvePublicApiBaseUrl(request);
  if (!baseUrl) {
    return corsJson({ error: "public_api_base_url_missing" }, requestOrigin, { status: 500 });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const db = getDb();

  const uploads: { id: string; url: string }[] = [];

  for (const file of files) {
    const contentType = typeof file.type === "string" && file.type.trim().length > 0 ? file.type.trim() : "";
    if (!contentType || !isAllowedContentType(contentType)) {
      return corsJson({ error: "unsupported_content_type", detail: contentType || null }, requestOrigin, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength <= 0) {
      return corsJson({ error: "empty_file" }, requestOrigin, { status: 400 });
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return corsJson({ error: "file_too_large" }, requestOrigin, { status: 400 });
    }

    const token = crypto.randomBytes(24).toString("base64url");
    const filename = sanitizeFilename(file.name);

    const [row] = await db
      .insert(inboxMediaUploads)
      .values({
        token,
        filename,
        contentType,
        bytes: Buffer.from(bytes),
        byteLength: bytes.byteLength,
        createdAt: now,
        expiresAt
      })
      .returning({ id: inboxMediaUploads.id });

    const id = row?.id;
    if (!id) {
      return corsJson({ error: "upload_failed" }, requestOrigin, { status: 500 });
    }

    const url = new URL(`/api/public/inbox/uploads/${id}`, baseUrl);
    url.searchParams.set("token", token);
    uploads.push({ id, url: url.toString() });
  }

  return corsJson({ ok: true, uploads }, requestOrigin);
}
