import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

const MAX_REVIEW_QUEUE_LIMIT = 100;
const MAX_REVIEW_CURSOR_LENGTH = 256;
const REVIEW_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;

type CaptureReviewPathResult =
  | { ok: true; path: string }
  | { ok: false; field: "limit" | "cursor"; message: string };

export function buildExactDuplicateCaptureReviewPath(
  requestUrl: string,
): CaptureReviewPathResult {
  const requested = new URL(requestUrl).searchParams;
  const limitValues = requested.getAll("limit");
  if (limitValues.length > 1) {
    return {
      ok: false,
      field: "limit",
      message: "Use one review queue limit.",
    };
  }
  const rawLimit = limitValues[0] ?? null;
  if (
    rawLimit !== null &&
    (!/^\d{1,3}$/u.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > MAX_REVIEW_QUEUE_LIMIT)
  ) {
    return {
      ok: false,
      field: "limit",
      message: `Use a review queue limit from 1 through ${MAX_REVIEW_QUEUE_LIMIT}.`,
    };
  }

  const cursorValues = requested.getAll("cursor");
  if (cursorValues.length > 1) {
    return {
      ok: false,
      field: "cursor",
      message: "Use one review queue cursor.",
    };
  }
  const cursor = cursorValues[0] ?? null;
  if (
    cursor !== null &&
    (cursor.length < 1 ||
      cursor.length > MAX_REVIEW_CURSOR_LENGTH ||
      !REVIEW_CURSOR_PATTERN.test(cursor))
  ) {
    return {
      ok: false,
      field: "cursor",
      message: "Refresh the duplicate review queue and try again.",
    };
  }

  const forwarded = new URLSearchParams();
  if (rawLimit !== null) forwarded.set("limit", String(Number(rawLimit)));
  if (cursor !== null) forwarded.set("cursor", cursor);
  const query = forwarded.toString();
  return {
    ok: true,
    path: `/api/admin/expenses/captures${query ? `?${query}` : ""}`,
  };
}

function invalidReviewQueryResponse(
  failure: Extract<CaptureReviewPathResult, { ok: false }>,
): Response {
  return Response.json(
    {
      ok: false,
      error: "invalid_capture_review_query",
      field: failure.field,
      message: failure.message,
      retryable: false,
    },
    { status: 400, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const upstreamPath = buildExactDuplicateCaptureReviewPath(request.url);
  if (!upstreamPath.ok) return invalidReviewQueryResponse(upstreamPath);
  return proxyMobileExpenseRequest(request, upstreamPath.path, {
    permission: "expenses.approve",
    method: "GET",
  });
}

export async function POST(request: Request): Promise<Response> {
  const upstream = await proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/captures",
    { permission: "expenses.submit", method: "POST" },
  );
  if (!upstream.ok) return upstream;

  const payload = (await upstream
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const capture =
    payload?.["capture"] && typeof payload["capture"] === "object"
      ? (payload["capture"] as Record<string, unknown>)
      : null;
  const captureId = typeof capture?.["id"] === "string" ? capture["id"] : null;
  if (!captureId || typeof payload?.["uploadUrl"] !== "string") {
    return upstream;
  }

  return Response.json(
    {
      ...payload,
      uploadUrl: `/api/mobile/expenses/captures/${encodeURIComponent(captureId)}/upload`,
      uploadHeaders: {},
    },
    { status: upstream.status, headers: { "Cache-Control": "no-store" } },
  );
}
