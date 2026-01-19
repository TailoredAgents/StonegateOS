import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, inboxMediaUploads } from "@/db";

type RouteContext = { params: Promise<{ uploadId?: string }> };

type UploadRow = {
  id: string;
  token: string;
  contentType: string;
  bytes: unknown;
  byteLength: number;
  expiresAt: unknown;
};

type ResolvedUpload = { upload: UploadRow } | { error: Response };

function readToken(request: NextRequest): string | null {
  const token = request.nextUrl.searchParams.get("token");
  return token && token.trim().length > 0 ? token.trim() : null;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

async function resolveUpload(request: NextRequest, context: RouteContext): Promise<ResolvedUpload> {
  const { uploadId } = await context.params;
  if (!uploadId) {
    return { error: NextResponse.json({ error: "upload_id_required" }, { status: 400, headers: corsHeaders() }) };
  }

  const token = readToken(request);
  if (!token) {
    return { error: NextResponse.json({ error: "token_required" }, { status: 401, headers: corsHeaders() }) };
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: inboxMediaUploads.id,
      token: inboxMediaUploads.token,
      contentType: inboxMediaUploads.contentType,
      bytes: inboxMediaUploads.bytes,
      byteLength: inboxMediaUploads.byteLength,
      expiresAt: inboxMediaUploads.expiresAt
    })
    .from(inboxMediaUploads)
    .where(eq(inboxMediaUploads.id, uploadId))
    .limit(1);

  if (!row) {
    return { error: NextResponse.json({ error: "not_found" }, { status: 404, headers: corsHeaders() }) };
  }
  if (row.token !== token) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders() }) };
  }

  const nowMs = Date.now();
  const expiresMs = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(String(row.expiresAt));
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    return { error: NextResponse.json({ error: "expired" }, { status: 410, headers: corsHeaders() }) };
  }

  return { upload: row };
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(request: NextRequest, context: RouteContext): Promise<Response> {
  const resolved = await resolveUpload(request, context);
  if ("error" in resolved) return resolved.error;

  const upload = resolved.upload;
  return new NextResponse(null, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": upload.contentType ?? "application/octet-stream",
      "Content-Length": String(upload.byteLength ?? 0),
      "Cache-Control": "public, max-age=3600"
    }
  });
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const resolved = await resolveUpload(request, context);
  if ("error" in resolved) return resolved.error;

  const upload = resolved.upload;
  const bytes = (() => {
    const raw = upload.bytes;
    if (raw instanceof Uint8Array) return raw;
    if (typeof raw === "string") {
      try {
        return Buffer.from(raw, "base64");
      } catch {
        return Buffer.from(raw);
      }
    }
    try {
      return Buffer.from(raw as Buffer);
    } catch {
      return new Uint8Array();
    }
  })();

  const safeBytes = bytes as unknown as Uint8Array<ArrayBuffer>;
  const blob = new Blob([safeBytes], {
    type: upload.contentType ?? "application/octet-stream"
  });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": upload.contentType ?? "application/octet-stream",
      "Content-Length": String(upload.byteLength ?? bytes.byteLength ?? 0),
      "Cache-Control": "public, max-age=3600"
    }
  });
}
