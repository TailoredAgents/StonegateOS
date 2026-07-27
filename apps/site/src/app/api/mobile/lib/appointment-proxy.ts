import { NextResponse } from "next/server";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "@/app/mobile/lib/session";
import { callAdminApi } from "@/app/team/lib/api";

type ProxyOptions = {
  permission: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  bodyMode?: "text" | "binary";
  maxBodyBytes?: number;
};

async function readBoundedBinaryBody(
  request: Request,
  maxBodyBytes: number,
): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export async function proxyMobileAppointmentRequest(
  request: Request,
  apiPath: string,
  options: ProxyOptions,
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  if (
    !hasMobilePermission(session.teamMember.permissions, options.permission)
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const method = options.method ?? "GET";
  let body: BodyInit | undefined;
  let contentType: string | null = null;
  if (method !== "GET" && method !== "DELETE") {
    if (options.bodyMode === "binary") {
      const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
      const contentLength = request.headers.get("content-length");
      const declaredLength =
        contentLength && /^\d+$/u.test(contentLength)
          ? Number(contentLength)
          : null;
      if (declaredLength !== null && declaredLength > maxBodyBytes) {
        return NextResponse.json(
          { ok: false, error: "payload_too_large" },
          { status: 413 },
        );
      }

      const bytes = await readBoundedBinaryBody(request, maxBodyBytes);
      if (!bytes) {
        return NextResponse.json(
          { ok: false, error: "payload_too_large" },
          { status: 413 },
        );
      }
      if (bytes.byteLength === 0) {
        return NextResponse.json(
          { ok: false, error: "empty_upload" },
          { status: 400 },
        );
      }
      body = bytes;
      contentType =
        request.headers.get("content-type") ?? "application/octet-stream";
    } else {
      const text = await request.text();
      body = text || undefined;
    }
  }
  const upstream = await callAdminApi(apiPath, {
    method,
    ...(body ? { body } : {}),
    ...(options.bodyMode === "binary" ? { timeoutMs: 60_000 } : {}),
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      "x-actor-type": "human",
      "x-actor-id": session.teamMember.id,
      "x-actor-label": session.teamMember.name,
      ...(session.teamMember.roleSlug
        ? { "x-actor-role": session.teamMember.roleSlug }
        : {}),
    },
  });
  const responseBody = await upstream.arrayBuffer();
  const responseContentType =
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8";

  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": responseContentType,
      "cache-control": "no-store",
    },
  });
}

export function encodeRouteId(value: string): string {
  return encodeURIComponent(value.trim());
}
