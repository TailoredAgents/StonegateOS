import type { NextRequest } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminMutationWithSafeReplay } from "@/app/team/lib/team-mutation-transport";
import {
  isExactReminderVersion,
  parseReminderMutationSuccess,
} from "@/app/team/lib/reminder-mutation";
import {
  isSameOriginReminderRequest,
  readReminderJson,
  reminderIdempotencyKey,
  reminderProxyError,
  reminderProxyResult,
  safeReminderFailure,
} from "./proxy";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BODY_KEYS = new Set([
  "assignedTo",
  "contactId",
  "dueAt",
  "notes",
  "title",
]);

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  if (!isSameOriginReminderRequest(request)) {
    return reminderProxyError(
      403,
      "forbidden",
      "The reminder request origin could not be verified.",
    );
  }
  if (request.nextUrl.search.length > 0) {
    return reminderProxyError(
      422,
      "invalid",
      "Reminder creation does not accept query parameters.",
    );
  }
  const idempotencyKey = reminderIdempotencyKey(request);
  if (!idempotencyKey) {
    return reminderProxyError(
      422,
      "invalid",
      "A stable request key is required.",
      { fieldErrors: { idempotencyKey: "Keep this form open and retry." } },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readReminderJson(request, BODY_KEYS);
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
        ? "The reminder request is too large."
        : "The reminder request is malformed or contains unsupported fields.",
      { fieldErrors: { request: "Keep your input and submit one reminder." } },
    );
  }

  const contactId =
    typeof payload["contactId"] === "string"
      ? payload["contactId"].normalize("NFKC").trim()
      : "";
  const dueAt =
    typeof payload["dueAt"] === "string" ? payload["dueAt"].trim() : "";
  const title =
    typeof payload["title"] === "string"
      ? payload["title"].normalize("NFKC").trim()
      : "";
  const rawNotes = payload["notes"];
  const notes =
    typeof rawNotes === "string" ? rawNotes.normalize("NFKC").trim() : null;
  const rawAssignedTo = payload["assignedTo"];
  const assignedTo =
    typeof rawAssignedTo === "string"
      ? rawAssignedTo.normalize("NFKC").trim()
      : null;
  if (!UUID_PATTERN.test(contactId)) {
    return reminderProxyError(422, "invalid", "Choose a valid contact.", {
      fieldErrors: { contactId: "Refresh the contact and try again." },
    });
  }
  if (!isExactReminderVersion(dueAt)) {
    return reminderProxyError(422, "invalid", "Choose a valid due time.", {
      fieldErrors: { dueAt: "Choose a date and time, then try again." },
    });
  }
  if (!title || title.length > 160) {
    return reminderProxyError(422, "invalid", "Enter a valid title.", {
      fieldErrors: { title: "Use 1–160 characters." },
    });
  }
  if (
    (rawNotes !== undefined && typeof rawNotes !== "string") ||
    (notes?.length ?? 0) > 4_000
  ) {
    return reminderProxyError(422, "invalid", "Enter valid notes.", {
      fieldErrors: { notes: "Use 4,000 characters or fewer." },
    });
  }
  if (
    rawAssignedTo !== undefined &&
    (typeof rawAssignedTo !== "string" || !UUID_PATTERN.test(assignedTo ?? ""))
  ) {
    return reminderProxyError(422, "invalid", "Choose a valid assignee.", {
      fieldErrors: { assignedTo: "Choose an active team member." },
    });
  }

  try {
    const apiResponse = await callAdminMutationWithSafeReplay(
      auth.principal,
      "/api/admin/crm/reminders",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          contactId,
          dueAt,
          title,
          ...(notes ? { notes } : {}),
          ...(assignedTo ? { assignedTo } : {}),
        }),
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
      actorId: auth.principal.memberId,
      contactId,
      status: "open",
    });
    if (!success) {
      return reminderProxyError(
        502,
        "internal",
        "The API returned an unverified reminder receipt. No success is being claimed; keep your input and refresh before retrying.",
        { retryable: true },
      );
    }
    return reminderProxyResult(
      success,
      201,
      apiResponse.headers.get("x-correlation-id"),
      apiResponse.headers.get("idempotency-replayed") === "true",
    );
  } catch {
    return reminderProxyError(
      504,
      "timeout",
      "The reminder result could not be confirmed. Keep your input and refresh before retrying with this same form.",
      { retryable: true },
    );
  }
}
