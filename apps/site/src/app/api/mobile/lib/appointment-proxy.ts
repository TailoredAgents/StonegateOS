import { NextResponse } from "next/server";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "@/app/mobile/lib/session";
import { callAdminApiForCurrentSession } from "@/app/team/lib/api";

type ProxyOptions = {
  permission: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  bodyMode?: "text" | "binary";
  maxBodyBytes?: number;
  forwardMutationHeaders?: boolean;
  rejectQueryParameters?: boolean;
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
      {
        ok: false,
        code: "unauthorized",
        message: "Your team session is missing, expired, or no longer active.",
        retryable: false,
      },
      { status: 401 },
    );
  }
  if (
    !hasMobilePermission(session.teamMember.permissions, options.permission)
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message: "You do not have permission to perform this action.",
        retryable: false,
      },
      { status: 403 },
    );
  }

  const method = options.method ?? "GET";
  if (
    options.rejectQueryParameters &&
    new URL(request.url).searchParams.size > 0
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "This request does not accept query parameters.",
        retryable: false,
      },
      { status: 422 },
    );
  }
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
      const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
      const contentLength = request.headers.get("content-length");
      const declaredLength =
        contentLength && /^\d+$/u.test(contentLength)
          ? Number(contentLength)
          : null;
      if (declaredLength !== null && declaredLength > maxBodyBytes) {
        return NextResponse.json(
          {
            ok: false,
            code: "invalid",
            message: "The request body is too large.",
            retryable: false,
          },
          { status: 413 },
        );
      }
      const bytes = await readBoundedBinaryBody(request, maxBodyBytes);
      if (!bytes) {
        return NextResponse.json(
          {
            ok: false,
            code: "invalid",
            message: "The request body is too large.",
            retryable: false,
          },
          { status: 413 },
        );
      }
      body = bytes.byteLength > 0 ? bytes : undefined;
      contentType = request.headers.get("content-type");
    }
  }
  const forwardedMutationHeaders = options.forwardMutationHeaders
    ? Object.fromEntries(
        [
          "idempotency-key",
          "if-match",
          "x-expected-version",
          "x-correlation-id",
        ]
          .map((name) => [name, request.headers.get(name)] as const)
          .filter((entry): entry is readonly [string, string] =>
            Boolean(entry[1]),
          ),
      )
    : {};
  const upstream = await callAdminApiForCurrentSession(apiPath, {
    method,
    ...(body ? { body } : {}),
    ...(options.bodyMode === "binary" ? { timeoutMs: 60_000 } : {}),
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...forwardedMutationHeaders,
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
  const responseHeaders = new Headers({
    "content-type": responseContentType,
    "cache-control": "no-store",
  });
  for (const name of [
    "idempotency-replayed",
    "retry-after",
    "x-correlation-id",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export function encodeRouteId(value: string): string {
  return encodeURIComponent(value.trim());
}
