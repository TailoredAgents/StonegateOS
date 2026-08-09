import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminMutationWithSafeReplay } from "@/app/team/lib/team-mutation-transport";
import { parseReminderMutationSuccess } from "@/app/team/lib/reminder-mutation";
import {
  isSameOriginReminderRequest,
  readReminderJson,
  reminderExpectedVersion,
  reminderIdempotencyKey,
  reminderProxyError,
  reminderProxyResult,
  safeReminderFailure,
} from "../proxy";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UPDATE_KEYS = new Set(["dueAt", "notes", "title"]);
type RouteContext = { params: Promise<{ taskId?: string }> };

async function mutationContext(
  request: NextRequest,
  context: RouteContext,
): Promise<
  | {
      ok: true;
      auth: Extract<
        Awaited<ReturnType<typeof requireTeamPrincipal>>,
        { ok: true }
      >;
      expectedVersion: string;
      idempotencyKey: string;
      taskId: string;
    }
  | { ok: false; response: Response }
> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.write",
    returnJson: true,
  });
  if (!auth.ok) return { ok: false, response: auth.response };
  if (!isSameOriginReminderRequest(request)) {
    return {
      ok: false,
      response: reminderProxyError(
        403,
        "forbidden",
        "The reminder request origin could not be verified.",
      ),
    };
  }
  const taskId = (await context.params).taskId?.normalize("NFKC").trim() ?? "";
  if (!UUID_PATTERN.test(taskId)) {
    return {
      ok: false,
      response: reminderProxyError(422, "invalid", "Choose a valid reminder.", {
        fieldErrors: { taskId: "Refresh the reminders and try again." },
      }),
    };
  }
  const idempotencyKey = reminderIdempotencyKey(request);
  if (!idempotencyKey) {
    return {
      ok: false,
      response: reminderProxyError(
        422,
        "invalid",
        "A stable request key is required.",
        { fieldErrors: { idempotencyKey: "Keep this form open and retry." } },
      ),
    };
  }
  const expectedVersion = reminderExpectedVersion(request);
  if (!expectedVersion) {
    return {
      ok: false,
      response: reminderProxyError(
        422,
        "invalid",
        "The latest reminder version is required.",
        { fieldErrors: { version: "Refresh the reminder and try again." } },
      ),
    };
  }
  return { ok: true, auth, expectedVersion, idempotencyKey, taskId };
}

async function proxyMutation(
  route: Extract<Awaited<ReturnType<typeof mutationContext>>, { ok: true }>,
  init: { method: "PATCH" | "POST"; body?: string },
  expectedStatus: "open" | "completed",
): Promise<Response> {
  try {
    const apiResponse = await callAdminMutationWithSafeReplay(
      route.auth.principal,
      `/api/admin/crm/reminders/${encodeURIComponent(route.taskId)}`,
      {
        method: init.method,
        headers: {
          "Idempotency-Key": route.idempotencyKey,
          "If-Match": `"${route.expectedVersion}"`,
        },
        ...(init.body ? { body: init.body } : {}),
        timeoutMs: 8_000,
      },
    );
    const body = (await apiResponse.json().catch(() => null)) as unknown;
    if (!apiResponse.ok) {
      const failure = safeReminderFailure(body, apiResponse.status);
      return reminderProxyError(
        apiResponse.status,
        failure.code,
        failure.message,
        {
          retryable: failure.retryable,
          ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
        },
      );
    }
    const success = parseReminderMutationSuccess(body, {
      actorId: route.auth.principal.memberId,
      taskId: route.taskId,
      status: expectedStatus,
    });
    if (!success) {
      return reminderProxyError(
        502,
        "internal",
        "The API returned an unverified reminder receipt. No success is being claimed; refresh before retrying.",
        { retryable: true },
      );
    }
    return reminderProxyResult(
      success,
      200,
      apiResponse.headers.get("x-correlation-id"),
      apiResponse.headers.get("idempotency-replayed") === "true",
    );
  } catch {
    return reminderProxyError(
      504,
      "timeout",
      "The reminder result could not be confirmed. Refresh before retrying with the same open form.",
      { retryable: true },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const route = await mutationContext(request, context);
  if (!route.ok) return route.response;
  if (request.nextUrl.search.length > 0) {
    return reminderProxyError(
      422,
      "invalid",
      "Reminder updates do not accept query parameters.",
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readReminderJson(request, UPDATE_KEYS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_payload";
    return reminderProxyError(
      reason === "unsupported_media_type"
        ? 415
        : reason === "too_large"
          ? 413
          : 422,
      "invalid",
      reason === "too_large"
        ? "The reminder update is too large."
        : "The reminder update is malformed or contains unsupported fields.",
      { fieldErrors: { request: "Keep your changes and try again." } },
    );
  }
  const title =
    typeof payload["title"] === "string"
      ? payload["title"].normalize("NFKC").trim()
      : "";
  const dueAt =
    typeof payload["dueAt"] === "string" ? payload["dueAt"].trim() : "";
  const rawNotes = payload["notes"];
  const notes =
    typeof rawNotes === "string" ? rawNotes.normalize("NFKC").trim() : null;
  if (!title || title.length > 160) {
    return reminderProxyError(422, "invalid", "Enter a valid title.", {
      fieldErrors: { title: "Use 1–160 characters." },
    });
  }
  if (
    Number.isNaN(new Date(dueAt).getTime()) ||
    new Date(dueAt).toISOString() !== dueAt
  ) {
    return reminderProxyError(422, "invalid", "Choose a valid due time.", {
      fieldErrors: { dueAt: "Choose a date and time, then try again." },
    });
  }
  if (typeof rawNotes !== "string" || (notes?.length ?? 0) > 4_000) {
    return reminderProxyError(422, "invalid", "Enter valid notes.", {
      fieldErrors: { notes: "Use 4,000 characters or fewer." },
    });
  }
  return proxyMutation(
    route,
    { method: "PATCH", body: JSON.stringify({ title, dueAt, notes }) },
    "open",
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const route = await mutationContext(request, context);
  if (!route.ok) return route.response;
  if (request.nextUrl.search.length > 0) {
    return reminderProxyError(
      422,
      "invalid",
      "Reminder completion does not accept query parameters.",
    );
  }
  return proxyMutation(route, { method: "POST" }, "completed");
}
