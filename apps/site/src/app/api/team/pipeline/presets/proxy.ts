import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export function isSameOriginPipelinePresetRequest(
  request: NextRequest,
): boolean {
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

export function pipelinePresetIdempotencyKey(
  request: NextRequest,
): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw) return null;
  const value = raw.normalize("NFKC").trim();
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

export function pipelinePresetProxyError(
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

export function pipelinePresetProxyResult(
  result: MutationResult<unknown>,
  status: number,
  correlationId: string | null,
): NextResponse<MutationResult<unknown>> {
  return NextResponse.json(result, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
  });
}
