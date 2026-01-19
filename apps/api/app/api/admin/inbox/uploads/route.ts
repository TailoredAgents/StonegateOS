import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb, inboxMediaUploads } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;
const DEFAULT_TTL_DAYS = 7;

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
  return lower.startsWith("image/") || lower.startsWith("video/");
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const files = ["file", "files", "attachments"]
    .flatMap((key) => formData.getAll(key))
    .filter((value): value is File => value instanceof File && value.size > 0);

  if (files.length === 0) {
    return NextResponse.json({ error: "files_required" }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json({ error: "too_many_files" }, { status: 400 });
  }

  const baseUrl = resolvePublicApiBaseUrl(request);
  if (!baseUrl) {
    return NextResponse.json({ error: "public_api_base_url_missing" }, { status: 500 });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const db = getDb();

  const uploads: { id: string; url: string }[] = [];

  for (const file of files) {
    const contentType = typeof file.type === "string" && file.type.trim().length > 0 ? file.type.trim() : "";
    if (!contentType || !isAllowedContentType(contentType)) {
      return NextResponse.json({ error: "unsupported_content_type", detail: contentType || null }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength <= 0) {
      return NextResponse.json({ error: "empty_file" }, { status: 400 });
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 400 });
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
      return NextResponse.json({ error: "upload_failed" }, { status: 500 });
    }

    const url = new URL(`/api/public/inbox/uploads/${id}`, baseUrl);
    url.searchParams.set("token", token);
    uploads.push({ id, url: url.toString() });
  }

  return NextResponse.json({ ok: true, uploads });
}
