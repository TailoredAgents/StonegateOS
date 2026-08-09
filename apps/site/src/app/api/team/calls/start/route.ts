import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { isManualCallMutationSuccess } from "@/app/team/lib/manual-call-result";
import { requireTeamPrincipal } from "../../auth";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const CALL_ATTEMPT_HEADER_NAMES = [
  "x-call-attempt-state",
  "x-call-new-attempt",
  "x-call-operation-id",
  "x-call-operation-version",
] as const;

function copyCallAttemptHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of CALL_ATTEMPT_HEADER_NAMES) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const correlationId = response.headers.get("x-correlation-id");
  const replayed = response.headers.get("idempotency-replayed");
  if (correlationId) headers.set("x-correlation-id", correlationId);
  if (replayed) headers.set("idempotency-replayed", replayed);
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "calls.place",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message:
          "A stable call request key is required. Refresh and try again.",
        retryable: false,
        fieldErrors: { idempotencyKey: "Use a fresh call action." },
      },
      { status: 422 },
    );
  }

  const requestPayload = (await request.json().catch(() => null)) as {
    contactId?: string;
    taskId?: string | null;
  } | null;
  const contactId =
    typeof requestPayload?.contactId === "string"
      ? requestPayload.contactId.trim()
      : "";
  const taskId =
    typeof requestPayload?.taskId === "string"
      ? requestPayload.taskId.trim()
      : "";

  if (!contactId) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid",
        message: "A valid contact is required.",
        retryable: false,
        fieldErrors: { contactId: "Choose a valid contact." },
      },
      { status: 422 },
    );
  }

  let response: Response;
  try {
    response = await callAdminApiAs(auth.principal, "/api/admin/calls/start", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ contactId, ...(taskId ? { taskId } : {}) }),
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "timeout",
        message:
          "The call result could not be confirmed. Keep this attempt key and check CRM/Twilio activity before retrying.",
        retryable: false,
      },
      {
        status: 504,
        headers: {
          "x-call-attempt-state": "unknown",
          "x-call-new-attempt": "blocked",
        },
      },
    );
  }

  const upstreamPayload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    return NextResponse.json(
      isRecord(upstreamPayload) && upstreamPayload["ok"] === false
        ? upstreamPayload
        : {
            ok: false,
            code: "internal",
            message:
              "The call service returned an unreadable failure. No retry is being recommended until the attempt is checked.",
            retryable: false,
          },
      { status: response.status, headers: copyCallAttemptHeaders(response) },
    );
  }

  if (!isManualCallMutationSuccess(upstreamPayload, contactId)) {
    return NextResponse.json(
      {
        ok: false,
        code: "internal",
        message:
          "The call service returned an unreadable success receipt. No success is being claimed; refresh before retrying.",
        retryable: false,
      },
      {
        status: 502,
        headers: {
          "x-call-attempt-state": "unknown",
          "x-call-new-attempt": "blocked",
        },
      },
    );
  }

  const headers = copyCallAttemptHeaders(response);
  return NextResponse.json(upstreamPayload, {
    status: response.status,
    headers,
  });
}
