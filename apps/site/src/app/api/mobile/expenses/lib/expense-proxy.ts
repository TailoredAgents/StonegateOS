import { NextResponse } from "next/server";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
  type MobileSession,
} from "@/app/mobile/lib/session";
import { callAdminApiForCurrentSession } from "@/app/team/lib/api";

const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

type ExpenseProxyOptions = {
  permission: string | readonly string[];
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  bodyMode?: "json" | "binary";
  maxBodyBytes?: number;
  forwardMutationHeaders?: boolean;
  forwardRedirect?: boolean;
};

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable = false,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: code, code, message, retryable },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function hasAnyPermission(
  session: MobileSession,
  required: string | readonly string[],
): boolean {
  const permissions: readonly string[] =
    typeof required === "string" ? [required] : required;
  return permissions.some((permission) =>
    hasMobilePermission(session.teamMember.permissions, permission),
  );
}

export async function requireMobileExpenseSession(
  required: string | readonly string[],
): Promise<
  { ok: true; session: MobileSession } | { ok: false; response: NextResponse }
> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    return {
      ok: false,
      response: errorResponse(
        401,
        "unauthorized",
        "Your team session expired. Sign in again to continue.",
      ),
    };
  }
  if (!hasAnyPermission(session, required)) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "forbidden",
        "You do not have permission to use this expense feature.",
      ),
    };
  }
  return { ok: true, session };
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<ArrayBuffer | null> {
  const declared = request.headers.get("content-length")?.trim() ?? "";
  if (
    declared &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    return null;
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function forwardedHeaders(request: Request, includeMutationHeaders: boolean) {
  if (!includeMutationHeaders) return {};
  return Object.fromEntries(
    ["idempotency-key", "if-match", "x-expected-version", "x-correlation-id"]
      .map((name) => [name, request.headers.get(name)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
}

export async function proxyMobileExpenseRequest(
  request: Request,
  apiPath: string,
  options: ExpenseProxyOptions,
): Promise<Response> {
  const access = await requireMobileExpenseSession(options.permission);
  if (!access.ok) return access.response;

  const method = options.method ?? "GET";
  const bodyMode = options.bodyMode ?? "json";
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "DELETE") {
    const bytes = await readBoundedBody(
      request,
      options.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT,
    );
    if (bytes === null) {
      return errorResponse(
        413,
        "payload_too_large",
        "The expense request is too large.",
      );
    }
    if (bytes.byteLength > 0) body = bytes;
  }

  try {
    const upstream = await callAdminApiForCurrentSession(apiPath, {
      method,
      ...(options.forwardRedirect ? { redirect: "manual" as const } : {}),
      ...(body ? { body } : {}),
      ...(bodyMode === "binary" ? { timeoutMs: 5 * 60_000 } : {}),
      headers: {
        ...(request.headers.get("content-type")
          ? { "Content-Type": request.headers.get("content-type")! }
          : {}),
        ...forwardedHeaders(
          request,
          options.forwardMutationHeaders ?? method !== "GET",
        ),
      },
    });
    if (
      options.forwardRedirect &&
      upstream.status >= 300 &&
      upstream.status < 400
    ) {
      const location = upstream.headers.get("location") ?? "";
      let target: URL | null = null;
      try {
        target = new URL(location);
      } catch {
        target = null;
      }
      if (
        !target ||
        !["https:", "http:"].includes(target.protocol) ||
        target.username ||
        target.password
      ) {
        return errorResponse(
          502,
          "invalid_expense_receipt_location",
          "The private receipt link is unavailable. Try again.",
          true,
        );
      }
      return new Response(null, {
        status: 307,
        headers: {
          Location: target.toString(),
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const responseBody = await upstream.arrayBuffer();
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Type":
        upstream.headers.get("content-type") ??
        "application/json; charset=utf-8",
    });
    for (const name of [
      "content-disposition",
      "idempotency-replayed",
      "retry-after",
      "x-correlation-id",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(responseBody, { status: upstream.status, headers });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return errorResponse(
      timedOut ? 504 : 502,
      timedOut ? "expense_service_timeout" : "expense_service_unavailable",
      timedOut
        ? "The expense service took too long to respond. Try again."
        : "The expense service is unavailable. Try again.",
      true,
    );
  }
}

export function encodeExpenseRouteId(value: string): string {
  return encodeURIComponent(value.trim());
}

export async function readMobileExpenseBody(
  request: Request,
  maximumBytes: number,
): Promise<ArrayBuffer | null> {
  return readBoundedBody(request, maximumBytes);
}
