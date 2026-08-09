import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readBoundedRequestBytes } from "@/app/team/lib/bounded-request";
import { isExactReminderVersion } from "@/app/team/lib/reminder-mutation";

const MAXIMUM_BODY_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isSameOriginReminderRequest(request: NextRequest): boolean {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!rawOrigin || rawOrigin === "null") return false;
  if (fetchSite && fetchSite !== "same-origin") return false;
  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return (
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin.toLowerCase() === target.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function reminderIdempotencyKey(request: NextRequest): string | null {
  const value =
    request.headers.get("idempotency-key")?.normalize("NFKC").trim() ?? "";
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

export function reminderExpectedVersion(request: NextRequest): string | null {
  let value = request.headers.get("if-match")?.trim() ?? "";
  if (value.startsWith('W/"') && value.endsWith('"')) {
    value = value.slice(3, -1);
  } else if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return isExactReminderVersion(value) ? value : null;
}

export async function readReminderJson(
  request: NextRequest,
  allowedKeys: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new Error("unsupported_media_type");
  }
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error("unsupported_media_type");
  }
  const bytes = await readBoundedRequestBytes(request, MAXIMUM_BODY_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const payload = record(JSON.parse(text) as unknown);
  if (!payload || Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid_payload");
  }
  return payload;
}

export function reminderProxyError(
  status: number,
  code: Extract<MutationResult<never>, { ok: false }>["code"],
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
  } = {},
): NextResponse<MutationResult<never>> {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    },
    {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

export function safeReminderFailure(
  value: unknown,
  status: number,
): Extract<MutationResult<never>, { ok: false }> {
  const payload = record(value);
  const code = payload?.["code"];
  const allowedCodes = new Set([
    "unauthorized",
    "forbidden",
    "conflict",
    "invalid",
    "rate_limited",
    "timeout",
    "provider_failed",
    "internal",
  ]);
  const safeCode =
    typeof code === "string" && allowedCodes.has(code)
      ? (code as Extract<MutationResult<never>, { ok: false }>["code"])
      : status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : status === 400 ||
                status === 413 ||
                status === 415 ||
                status === 422
              ? "invalid"
              : status === 429
                ? "rate_limited"
                : status === 408 || status === 504
                  ? "timeout"
                  : status === 502 || status === 503
                    ? "provider_failed"
                    : "internal";
  const message =
    typeof payload?.["message"] === "string" &&
    payload["message"].trim().length > 0 &&
    payload["message"].length <= 1_000
      ? payload["message"].trim()
      : "The reminder service could not confirm this change.";
  const rawFieldErrors = record(payload?.["fieldErrors"]);
  const fieldErrors = rawFieldErrors
    ? Object.fromEntries(
        Object.entries(rawFieldErrors).flatMap(([key, item]) =>
          /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) &&
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= 500
            ? [[key, item]]
            : [],
        ),
      )
    : undefined;
  return {
    ok: false,
    code: safeCode,
    message,
    retryable: payload?.["retryable"] === true,
    ...(fieldErrors && Object.keys(fieldErrors).length > 0
      ? { fieldErrors }
      : {}),
  };
}

export function reminderProxyResult(
  result: MutationResult<unknown>,
  status: number,
  correlationId: string | null,
  replayed: boolean,
): NextResponse<MutationResult<unknown>> {
  return NextResponse.json(result, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
      ...(replayed ? { "idempotency-replayed": "true" } : {}),
    },
  });
}
