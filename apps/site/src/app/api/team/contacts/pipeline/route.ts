import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { readBoundedRequestBytes } from "@/app/team/lib/bounded-request";
import {
  isPipelineExpectedVersion,
  parsePipelineConflictState,
  parsePipelineStageMutationSuccess,
} from "@/app/team/lib/pipeline-stage-mutation";

export const dynamic = "force-dynamic";

const MAXIMUM_REQUEST_BYTES = 4 * 1024;
const NOTE_MAXIMUM_LENGTH = 2_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const PIPELINE_STAGES = new Set([
  "new",
  "contacted",
  "in_person_quote",
  "qualified",
  "quoted",
  "won",
  "lost",
]);
const BODY_KEYS = new Set(["contactId", "notes", "previousStage", "stage"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function proxyError(
  status: number,
  code: Extract<MutationResult<never>, { ok: false }>["code"],
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
    current?: unknown;
  } = {},
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
      ...(options.current ? { current: options.current } : {}),
    },
    {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

function isSameOrigin(request: NextRequest): boolean {
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

function unquoteVersion(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1);
  }
  return normalized || null;
}

async function readPayload(
  request: NextRequest,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new Error("unsupported_media_type");
  }
  const bytes = await readBoundedRequestBytes(request, MAXIMUM_REQUEST_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  const payload = record(value);
  if (!payload || Object.keys(payload).some((key) => !BODY_KEYS.has(key))) {
    throw new Error("invalid_payload");
  }
  return payload;
}

function safeFailure(
  value: unknown,
  status: number,
): {
  code: Extract<MutationResult<never>, { ok: false }>["code"];
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string>;
  current?: unknown;
} {
  const payload = record(value);
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
  const code =
    typeof payload?.["code"] === "string" && allowedCodes.has(payload["code"])
      ? (payload["code"] as Extract<
          MutationResult<never>,
          { ok: false }
        >["code"])
      : status === 409
        ? "conflict"
        : status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 422
              ? "invalid"
              : "internal";
  const message =
    typeof payload?.["message"] === "string" &&
    payload["message"].trim().length > 0 &&
    payload["message"].length <= 1_000
      ? payload["message"].trim()
      : "The pipeline service could not confirm this change.";
  const rawFieldErrors = record(payload?.["fieldErrors"]);
  const fieldErrors = rawFieldErrors
    ? Object.fromEntries(
        Object.entries(rawFieldErrors).flatMap(([key, item]) =>
          /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(key) &&
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= 500
            ? [[key, item]]
            : [],
        ),
      )
    : undefined;
  const current = status === 409 ? parsePipelineConflictState(payload) : null;
  return {
    code,
    message,
    retryable: payload?.["retryable"] === true,
    ...(fieldErrors && Object.keys(fieldErrors).length > 0
      ? { fieldErrors }
      : {}),
    ...(current ? { current } : {}),
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "pipeline.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  if (!isSameOrigin(request)) {
    return proxyError(
      403,
      "forbidden",
      "The pipeline request origin could not be verified.",
    );
  }
  if (request.nextUrl.search.length > 0) {
    return proxyError(
      422,
      "invalid",
      "Pipeline stage updates do not accept query parameters.",
    );
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key") ?? "";
  const idempotencyKey = rawIdempotencyKey.normalize("NFKC").trim();
  const expectedVersion = unquoteVersion(request.headers.get("if-match"));
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return proxyError(422, "invalid", "A stable request key is required.", {
      fieldErrors: { idempotencyKey: "Refresh this CRM view and try again." },
    });
  }
  if (!isPipelineExpectedVersion(expectedVersion)) {
    return proxyError(
      422,
      "invalid",
      "The latest pipeline version is required.",
      { fieldErrors: { version: "Refresh the contact and try again." } },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_payload";
    return proxyError(
      reason === "unsupported_media_type"
        ? 415
        : reason === "too_large"
          ? 413
          : 422,
      "invalid",
      reason === "too_large"
        ? "The pipeline request is too large."
        : "The pipeline request is malformed or contains unsupported fields.",
      { fieldErrors: { request: "Refresh and submit one stage change." } },
    );
  }

  const contactId =
    typeof payload["contactId"] === "string"
      ? payload["contactId"].normalize("NFKC").trim()
      : "";
  const stage =
    typeof payload["stage"] === "string"
      ? payload["stage"].normalize("NFKC").trim().toLowerCase()
      : "";
  const previousStage =
    typeof payload["previousStage"] === "string"
      ? payload["previousStage"].normalize("NFKC").trim().toLowerCase()
      : "";
  const rawNotes = payload["notes"];
  const notes =
    typeof rawNotes === "string" ? rawNotes.normalize("NFKC").trim() : null;
  if (!UUID_PATTERN.test(contactId)) {
    return proxyError(422, "invalid", "Choose a valid contact.", {
      fieldErrors: { contactId: "Select an active contact." },
    });
  }
  if (!PIPELINE_STAGES.has(stage) || !PIPELINE_STAGES.has(previousStage)) {
    return proxyError(422, "invalid", "Choose a supported pipeline stage.", {
      fieldErrors: { stage: "Use a stage shown in the CRM." },
    });
  }
  if (
    (rawNotes !== undefined &&
      rawNotes !== null &&
      typeof rawNotes !== "string") ||
    (notes?.length ?? 0) > NOTE_MAXIMUM_LENGTH
  ) {
    return proxyError(422, "invalid", "The pipeline note is invalid.", {
      fieldErrors: {
        notes: `Use ${NOTE_MAXIMUM_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      },
    });
  }

  const callApi = () =>
    callAdminApiAs(
      auth.principal,
      `/api/admin/crm/pipeline/${encodeURIComponent(contactId)}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({ stage, ...(notes ? { notes } : {}) }),
        timeoutMs: 8_000,
      },
    );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const apiResponse = await callApi();
      const body = (await apiResponse.json().catch(() => null)) as unknown;
      if (!apiResponse.ok) {
        const failure = safeFailure(body, apiResponse.status);
        return proxyError(apiResponse.status, failure.code, failure.message, {
          retryable: failure.retryable,
          ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
          ...(failure.current ? { current: failure.current } : {}),
        });
      }
      const success = parsePipelineStageMutationSuccess(body, {
        actorId: auth.principal.memberId,
        contactId,
        stage,
        previousStage,
        submittedVersion: expectedVersion,
      });
      if (success) {
        return NextResponse.json(success, {
          status: 200,
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            ...(apiResponse.headers.get("x-correlation-id")
              ? {
                  "x-correlation-id":
                    apiResponse.headers.get("x-correlation-id")!,
                }
              : {}),
          },
        });
      }
      if (attempt === 0) continue;
      return proxyError(
        502,
        "internal",
        "The API returned an unverified pipeline receipt. Refresh before retrying; no success is being claimed.",
        { retryable: true },
      );
    } catch {
      if (attempt === 0) continue;
      return proxyError(
        502,
        "internal",
        "The pipeline service could not be reached. The result is not confirmed; refresh before retrying.",
        { retryable: true },
      );
    }
  }

  return proxyError(502, "internal", "The pipeline result is unavailable.", {
    retryable: true,
  });
}
