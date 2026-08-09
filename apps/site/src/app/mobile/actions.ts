"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { callAdminApiForCurrentSession } from "../team/lib/api";
import { callTeamApi, callTeamPublicApi } from "../team/login/lib/api";
import { parseAppointmentBookingFormData } from "../team/lib/booking-details";
import {
  readManualCallAttemptResponseMetadata,
  readManualCallMutationSuccess,
} from "../team/lib/manual-call-result";
import {
  findManualCallAttempt,
  MANUAL_CALL_ATTEMPT_COOKIE,
  manualCallAttemptScope,
  parseManualCallAttemptStore,
  removeManualCallAttempt,
  storeManualCallAttempt,
} from "@/lib/manual-call-attempt-store";
import { readTeamMutationSuccess } from "../team/lib/mutation-feedback";
import { callAdminMutationWithSafeReplay } from "../team/lib/team-mutation-transport";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import type { MobileSession } from "./lib/session";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "./lib/session";

async function requireMobilePermission(
  required: string,
): Promise<MobileSession> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    redirect("/mobile/login");
  }
  if (!hasMobilePermission(session.teamMember.permissions, required)) {
    redirect(`/mobile?error=${encodeURIComponent("forbidden")}` as Route);
  }
  return session;
}

function mobileReturnTo(value: unknown): Route {
  if (typeof value !== "string") return "/mobile";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/mobile") || trimmed.startsWith("//"))
    return "/mobile";
  return trimmed as Route;
}

function mobileReturnWithParam(
  returnTo: Route,
  key: string,
  value: string,
): Route {
  const separator = returnTo.includes("?") ? "&" : "?";
  return `${returnTo}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}` as Route;
}

async function requireMobileOwner(): Promise<void> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    redirect("/mobile/login");
  }
  if (!session.isOwner) {
    redirect(
      `/mobile?screen=owner&error=${encodeURIComponent("owner_required")}` as Route,
    );
  }
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as {
        error?: unknown;
        detail?: unknown;
        message?: unknown;
      };
      for (const candidate of [json.message, json.detail, json.error]) {
        if (typeof candidate === "string" && candidate.trim())
          return candidate.trim();
      }
      return fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

function parseDayWindow(
  dayKey: string,
): { startAtFrom: string; startAtTo: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const start = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      0,
      0,
      0,
      0,
    ),
  );
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 4);
  return {
    startAtFrom: start.toISOString(),
    startAtTo: end.toISOString(),
  };
}

function parseMobileMoneyToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [dollars, fractional = ""] = normalized.split(".");
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000
    ? cents
    : null;
}

const MOBILE_MUTATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const MOBILE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseMobileNullableUuid(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return null;
  return MOBILE_UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function parseMobileAppointmentVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(normalized).toISOString() !== normalized
  ) {
    return null;
  }
  return normalized;
}

function parseMobileMutationKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return MOBILE_MUTATION_KEY_PATTERN.test(normalized) ? normalized : null;
}

function parseMobileStatusMessageIntent(
  formData: FormData,
  name: "sendCustomerNotification" | "sendReviewRequest",
): boolean | null {
  const values = formData.getAll(name);
  if (values.length === 0) return false;
  return values.length === 1 && values[0] === "on" ? true : null;
}

function mobileScheduleRedirect(
  screen: string,
  dayKey: string,
  error?: string,
): Route {
  const normalizedScreen = screen === "calendar" ? "calendar" : "myday";
  const params = new URLSearchParams();
  params.set("screen", normalizedScreen);
  if (dayKey) params.set("date", dayKey);
  if (error) params.set("error", error);
  return `/mobile?${params.toString()}` as Route;
}

type MobileAppointmentLookupResponse = {
  appointments?: Array<{
    id?: string;
    contact?: {
      id?: string | null;
    } | null;
  }>;
};

type MobileThreadListResponse = {
  threads?: Array<{
    id?: string;
  }>;
};

type MobileEnsureThreadResponse = {
  ok?: boolean;
  threadId?: string;
};

export async function sendMobileThreadMessageAction(formData: FormData) {
  await requireMobilePermission("messages.send");

  const threadIdRaw = formData.get("threadId");
  const channelRaw = formData.get("channel");
  const bodyRaw = formData.get("body");
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const channel = typeof channelRaw === "string" ? channelRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";

  if (!threadId) {
    redirect("/mobile?error=thread_required");
  }
  if (!body) {
    redirect(
      `/mobile?threadId=${encodeURIComponent(threadId)}&error=message_required`,
    );
  }

  const response = await callAdminApiForCurrentSession(
    `/api/admin/inbox/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body,
        direction: "outbound",
        ...(channel ? { channel } : {}),
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "send_failed");
    redirect(
      `/mobile?threadId=${encodeURIComponent(threadId)}&error=${encodeURIComponent(message)}`,
    );
  }

  revalidatePath("/mobile");
  redirect(`/mobile?threadId=${encodeURIComponent(threadId)}&sent=1`);
}

export async function openMobileAppointmentThreadAction(formData: FormData) {
  const session = await requireMobilePermission("messages.read");

  const appointmentIdRaw = formData.get("appointmentId");
  const dateRaw = formData.get("date");
  const screenRaw = formData.get("screen");
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const dayKey = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const screen = typeof screenRaw === "string" ? screenRaw.trim() : "myday";
  const returnTo = mobileScheduleRedirect(screen, dayKey);

  if (!appointmentId) {
    redirect(mobileScheduleRedirect(screen, dayKey, "appointment_required"));
  }

  const window = parseDayWindow(dayKey);
  const appointmentParams = new URLSearchParams();
  appointmentParams.set("status", "all");
  appointmentParams.set("limit", "200");
  if (window) {
    appointmentParams.set("startAtFrom", window.startAtFrom);
    appointmentParams.set("startAtTo", window.startAtTo);
  }

  const appointmentResponse = await callAdminApiForCurrentSession(
    `/api/appointments?${appointmentParams.toString()}`,
    {
      method: "GET",
    },
  );
  if (!appointmentResponse.ok) {
    const message = await readErrorMessage(
      appointmentResponse,
      "appointment_lookup_failed",
    );
    redirect(mobileScheduleRedirect(screen, dayKey, message));
  }

  const appointmentPayload = (await appointmentResponse
    .json()
    .catch(() => null)) as MobileAppointmentLookupResponse | null;
  const appointment = (appointmentPayload?.appointments ?? []).find(
    (item) => item.id === appointmentId,
  );
  const contactId =
    typeof appointment?.contact?.id === "string"
      ? appointment.contact.id.trim()
      : "";

  if (!contactId || contactId === "unknown") {
    redirect(mobileScheduleRedirect(screen, dayKey, "contact_not_found"));
  }

  const threadsResponse = await callAdminApiForCurrentSession(
    `/api/admin/inbox/threads?contactId=${encodeURIComponent(contactId)}&limit=1`,
    {
      method: "GET",
    },
  );
  if (!threadsResponse.ok) {
    const message = await readErrorMessage(
      threadsResponse,
      "thread_lookup_failed",
    );
    redirect(mobileScheduleRedirect(screen, dayKey, message));
  }

  const threadsPayload = (await threadsResponse
    .json()
    .catch(() => null)) as MobileThreadListResponse | null;
  const existingThreadId =
    threadsPayload?.threads
      ?.find((thread) => typeof thread.id === "string" && thread.id.trim())
      ?.id?.trim() ?? "";

  if (existingThreadId) {
    redirect(
      `/mobile?threadId=${encodeURIComponent(existingThreadId)}` as Route,
    );
  }

  if (hasMobilePermission(session.teamMember.permissions, "messages.send")) {
    const ensureResponse = await callAdminApiForCurrentSession(
      "/api/admin/inbox/threads/ensure",
      {
        method: "POST",
        body: JSON.stringify({ contactId, channel: "sms" }),
      },
    );

    if (ensureResponse.ok) {
      const ensurePayload = (await ensureResponse
        .json()
        .catch(() => null)) as MobileEnsureThreadResponse | null;
      const ensuredThreadId =
        typeof ensurePayload?.threadId === "string"
          ? ensurePayload.threadId.trim()
          : "";
      if (ensuredThreadId) {
        redirect(
          `/mobile?threadId=${encodeURIComponent(ensuredThreadId)}` as Route,
        );
      }
    }
  }

  redirect(mobileReturnWithParam(returnTo, "error", "thread_not_found"));
}

export async function updateMobileAppointmentEtaStatusAction(
  formData: FormData,
) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const statusRaw = formData.get("etaStatus");
  const dateRaw = formData.get("date");
  const screenRaw = formData.get("screen");
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const etaStatus = typeof statusRaw === "string" ? statusRaw.trim() : "";
  const dayKey = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const screen = typeof screenRaw === "string" ? screenRaw.trim() : "myday";

  if (!appointmentId || !etaStatus) {
    redirect(mobileScheduleRedirect(screen, dayKey, "eta_status_required"));
  }

  const response = await callAdminApiForCurrentSession(
    `/api/appointments/${encodeURIComponent(appointmentId)}/eta-status`,
    {
      method: "POST",
      body: JSON.stringify({ status: etaStatus, source: "mobile" }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "eta_status_failed");
    redirect(mobileScheduleRedirect(screen, dayKey, message));
  }

  revalidatePath("/mobile");
  redirect(`${mobileScheduleRedirect(screen, dayKey)}&eta=1` as Route);
}

export async function openMobileContactThreadAction(formData: FormData) {
  await requireMobilePermission("messages.send");

  const contactIdRaw = formData.get("contactId");
  const channelRaw = formData.get("channel");
  const returnTo = mobileReturnTo(formData.get("returnTo"));
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const requestedChannel =
    typeof channelRaw === "string" ? channelRaw.trim() : "sms";
  const channel = requestedChannel === "email" ? "email" : "sms";

  if (!contactId) {
    redirect(mobileReturnWithParam(returnTo, "error", "contact_required"));
  }

  const response = await callAdminApiForCurrentSession(
    "/api/admin/inbox/threads/ensure",
    {
      method: "POST",
      body: JSON.stringify({ contactId, channel }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "thread_create_failed");
    redirect(mobileReturnWithParam(returnTo, "error", message));
  }

  const payload = (await response
    .json()
    .catch(() => null)) as MobileEnsureThreadResponse | null;
  const threadId =
    typeof payload?.threadId === "string" ? payload.threadId.trim() : "";

  if (!threadId) {
    redirect(mobileReturnWithParam(returnTo, "error", "thread_create_failed"));
  }

  revalidatePath("/mobile");
  redirect(`/mobile?threadId=${encodeURIComponent(threadId)}` as Route);
}

export async function startMobileContactCallAction(formData: FormData) {
  const session = await requireMobilePermission("calls.place");
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const threadIdRaw = formData.get("threadId");
  const returnTo = mobileReturnTo(formData.get("returnTo"));
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";

  if (!contactId) {
    redirect(mobileReturnWithParam(returnTo, "error", "contact_required"));
  }

  const submittedKey = formData.get("idempotencyKey");
  const explicitNewAttempt = formData.get("explicitNewAttempt");
  if (
    typeof submittedKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(submittedKey)
  ) {
    redirect(
      mobileReturnWithParam(returnTo, "error", "call_action_expired_refresh"),
    );
  }
  const scopeHash = manualCallAttemptScope(contactId, null);
  const attempts = parseManualCallAttemptStore(
    jar.get(MANUAL_CALL_ATTEMPT_COOKIE)?.value,
  );
  const existingAttempt = findManualCallAttempt(attempts, scopeHash);
  let idempotencyKey = submittedKey;
  if (
    existingAttempt?.state === "pending" ||
    existingAttempt?.state === "ambiguous"
  ) {
    idempotencyKey = existingAttempt.key;
  } else if (existingAttempt?.state === "confirmed_not_sent") {
    if (
      explicitNewAttempt !== "START NEW CALL" ||
      submittedKey === existingAttempt.key
    ) {
      redirect(
        mobileReturnWithParam(
          returnTo,
          "error",
          "refresh_then_explicitly_start_new_call",
        ),
      );
    }
  }
  const setAttemptCookie = (value: string): void => {
    jar.set({
      name: MANUAL_CALL_ATTEMPT_COOKIE,
      value,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  };
  setAttemptCookie(
    storeManualCallAttempt(attempts, {
      scopeHash,
      key: idempotencyKey,
      state: "pending",
    }),
  );

  let response: Response;
  try {
    response = await callAdminApiForCurrentSession("/api/admin/calls/start", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        contactId,
        agentMemberId: session.teamMember.id,
      }),
    });
  } catch {
    setAttemptCookie(
      storeManualCallAttempt(attempts, {
        scopeHash,
        key: idempotencyKey,
        state: "ambiguous",
      }),
    );
    redirect(
      mobileReturnWithParam(
        returnTo,
        "error",
        "call_result_unknown_same_attempt_will_be_reused",
      ),
    );
  }

  if (!response.ok) {
    const metadata = readManualCallAttemptResponseMetadata(response);
    setAttemptCookie(
      storeManualCallAttempt(attempts, {
        scopeHash,
        key: idempotencyKey,
        state:
          metadata?.state === "confirmed_not_sent" &&
          metadata.newAttempt === "explicit"
            ? "confirmed_not_sent"
            : "ambiguous",
      }),
    );
    const message = await readErrorMessage(response, "call_failed");
    redirect(mobileReturnWithParam(returnTo, "error", message));
  }

  const receipt = await readManualCallMutationSuccess(response, contactId);
  if (!receipt) {
    setAttemptCookie(
      storeManualCallAttempt(attempts, {
        scopeHash,
        key: idempotencyKey,
        state: "ambiguous",
      }),
    );
    redirect(
      mobileReturnWithParam(
        returnTo,
        "error",
        "call_receipt_unreadable_refresh_before_retry",
      ),
    );
  }

  setAttemptCookie(removeManualCallAttempt(attempts, scopeHash));

  if (threadId) {
    await callAdminApiForCurrentSession(
      `/api/admin/inbox/threads/${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ action: "mark_handled" }),
      },
    ).catch(() => null);
  }

  revalidatePath("/mobile");
  redirect(
    mobileReturnWithParam(
      returnTo,
      "call",
      receipt.data.state === "failed" ? "not_connected" : "started",
    ),
  );
}

export async function markMobileThreadHandledAction(formData: FormData) {
  await requireMobilePermission("messages.send");

  const threadIdRaw = formData.get("threadId");
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  if (!threadId) {
    redirect("/mobile?error=thread_required" as Route);
  }

  const response = await callAdminApiForCurrentSession(
    `/api/admin/inbox/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ action: "mark_handled" }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "mark_handled_failed");
    redirect(
      `/mobile?threadId=${encodeURIComponent(threadId)}&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(
    `/mobile?threadId=${encodeURIComponent(threadId)}&handled=1` as Route,
  );
}

export async function closeMobileThreadAction(formData: FormData) {
  await requireMobilePermission("messages.send");

  const threadIdRaw = formData.get("threadId");
  const closeReasonRaw = formData.get("closeReason");
  const dncReasonRaw = formData.get("doNotContactReason");
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const closeReason =
    typeof closeReasonRaw === "string" ? closeReasonRaw.trim() : "";
  const doNotContactReason =
    typeof dncReasonRaw === "string" ? dncReasonRaw.trim() : "";
  const allowedReasons = new Set(["lost", "do_not_contact", "closed"]);

  if (!threadId) {
    redirect("/mobile?error=thread_required" as Route);
  }
  if (!allowedReasons.has(closeReason)) {
    redirect(
      `/mobile?threadId=${encodeURIComponent(threadId)}&error=invalid_close_reason` as Route,
    );
  }

  const response = await callAdminApiForCurrentSession(
    `/api/admin/inbox/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "closed",
        closeReason,
        ...(closeReason === "do_not_contact"
          ? {
              doNotContact: true,
              doNotContactReason:
                doNotContactReason ||
                "Marked Do Not Contact from mobile inbox.",
            }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "close_failed");
    redirect(
      `/mobile?threadId=${encodeURIComponent(threadId)}&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(`/mobile?closed=1` as Route);
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLength = 60;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function parseUsdToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parseUsdToDollars(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100) / 100;
}

const mobileQuoteServiceIds = new Set([
  "single-item",
  "furniture",
  "appliances",
  "yard-waste",
  "construction-debris",
  "hot-tub",
  "other",
]);

export async function addMobileContactNoteAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const threadIdRaw = formData.get("threadId");
  const bodyRaw = formData.get("body");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";

  const makeRedirect = (params: Record<string, string>): Route => {
    const searchParams = new URLSearchParams();
    if (threadId) searchParams.set("threadId", threadId);
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    const query = searchParams.toString();
    return (query ? `/mobile?${query}` : "/mobile") as Route;
  };

  if (!contactId) {
    redirect(makeRedirect({ error: "contact_required" }));
  }
  if (!body) {
    redirect(makeRedirect({ error: "note_required" }));
  }

  const response = await callAdminApiForCurrentSession("/api/admin/crm/tasks", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      title: makeNoteTitle(body),
      notes: body,
      status: "completed",
    }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "note_failed");
    redirect(makeRedirect({ error: message }));
  }

  revalidatePath("/mobile");
  redirect(makeRedirect({ note: "1" }));
}

export async function completeMobileTaskAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const taskIdRaw = formData.get("taskId");
  const screenRaw = formData.get("screen");
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const screen =
    typeof screenRaw === "string" && screenRaw.trim() === "contacts"
      ? "contacts"
      : "myday";
  const redirectPath =
    screen === "contacts" ? "/mobile?screen=contacts" : "/mobile?screen=myday";

  if (!taskId) {
    redirect(`${redirectPath}&error=task_required` as Route);
  }

  const response = await callAdminApiForCurrentSession(
    `/api/admin/crm/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "task_update_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&task=1` as Route);
}

export async function mobileLogoutAction() {
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (token) {
    await callTeamApi("/api/team/logout", { method: "POST" }).catch(() => null);
  }
  jar.delete(TEAM_SESSION_COOKIE);
  redirect("/mobile/login");
}

export async function createMobileExpenseAction(formData: FormData) {
  await requireMobilePermission("expenses.write");

  const amountCents = parseMobileMoneyToCents(formData.get("amount"));
  const categoryRaw = formData.get("category");
  const category = typeof categoryRaw === "string" ? categoryRaw.trim() : "";
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string"
      ? idempotencyKeyRaw.normalize("NFKC").trim()
      : "";
  const paidAtRaw = formData.get("paidAt");
  const paidAt = typeof paidAtRaw === "string" ? paidAtRaw.trim() : "";
  const allowedCategories = new Set([
    "Dump",
    "Gas",
    "Food",
    "Equipment",
    "Vehicle",
    "Insurance",
    "Software",
  ]);
  const redirectPath = "/mobile?screen=expenses" as Route;

  if (amountCents === null) {
    redirect(`${redirectPath}&error=amount_required` as Route);
  }
  if (!allowedCategories.has(category)) {
    redirect(`${redirectPath}&error=category_required` as Route);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,149}$/u.test(idempotencyKey)) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("Expense form expired. Refresh and try again.")}` as Route,
    );
  }
  const paidAtDate = new Date(paidAt);
  if (
    Number.isNaN(paidAtDate.getTime()) ||
    paidAtDate.getTime() < Date.now() - 24 * 60 * 60 * 1_000 ||
    paidAtDate.getTime() > Date.now() + 24 * 60 * 60 * 1_000
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("Expense form expired. Refresh and try again.")}` as Route,
    );
  }

  const body = new FormData();
  body.set("amountCents", String(amountCents));
  body.set("currency", "USD");
  body.set("category", category);
  body.set("paidAt", paidAtDate.toISOString());

  let response: Response;
  try {
    response = await callAdminApiForCurrentSession("/api/admin/expenses", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body,
    });
  } catch {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The expense service is unavailable. Nothing was reported as saved.")}` as Route,
    );
  }

  if (!response.ok) {
    const message = await readErrorMessage(response, "expense_save_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  const created = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    ok?: unknown;
    data?: { expenseId?: unknown; version?: unknown };
  } | null;
  const expenseId =
    typeof created?.data?.expenseId === "string"
      ? created.data.expenseId.trim()
      : "";
  const version = created?.data?.version;
  if (
    created?.ok !== true ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      expenseId,
    ) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The expense service did not return a valid save receipt. Review Team Expenses before retrying.")}` as Route,
    );
  }

  let postResponse: Response;
  try {
    postResponse = await callAdminApiForCurrentSession(
      `/api/admin/expenses/${encodeURIComponent(expenseId)}/post`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `${idempotencyKey}:post`,
          "If-Match": String(version),
        },
        body: JSON.stringify({}),
      },
    );
  } catch {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("Expense saved as a draft, but posting could not be confirmed. Review it in Team Expenses before retrying.")}` as Route,
    );
  }
  const posted = (await postResponse
    .clone()
    .json()
    .catch(() => null)) as { ok?: unknown } | null;
  if (!postResponse.ok || posted?.ok !== true) {
    const message = await readErrorMessage(postResponse, "posting_failed");
    redirect(
      `${redirectPath}&error=${encodeURIComponent(`Expense saved as a draft, but posting failed: ${message}. Review it in Team Expenses.`)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&expense=1` as Route);
}

export async function createMobileTeamMemberAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const nameRaw = formData.get("name");
  const emailRaw = formData.get("email");
  const roleIdRaw = formData.get("roleId");
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  const email =
    typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const roleId = typeof roleIdRaw === "string" ? roleIdRaw.trim() : "";
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";

  if (!name) {
    redirect("/mobile?screen=access&error=name_required");
  }
  if (!email) {
    redirect("/mobile?screen=access&error=email_required");
  }
  if (!roleId) {
    redirect("/mobile?screen=access&error=role_required");
  }
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    redirect("/mobile?screen=access&error=retry_key_required");
  }

  const principal = await requireCurrentTeamPrincipal();
  const response = await callAdminMutationWithSafeReplay(
    principal,
    "/api/admin/team/members",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        name,
        email,
        phone: null,
        roleId,
        active: true,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "member_create_failed");
    redirect(
      `/mobile?screen=access&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=access&account=created");
}

export async function updateMobileTeamMemberAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const memberIdRaw = formData.get("memberId");
  const nameRaw = formData.get("name");
  const emailRaw = formData.get("email");
  const roleIdRaw = formData.get("roleId");
  const phoneRaw = formData.get("phone");
  const expectedUpdatedAtRaw = formData.get("expectedUpdatedAt");
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : "";
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  const email =
    typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const roleId = typeof roleIdRaw === "string" ? roleIdRaw.trim() : "";
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";
  const expectedUpdatedAt =
    typeof expectedUpdatedAtRaw === "string"
      ? expectedUpdatedAtRaw.trim()
      : "";
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";

  if (!memberId) {
    redirect("/mobile?screen=access&error=member_required");
  }
  if (!name) {
    redirect("/mobile?screen=access&error=name_required");
  }
  if (!roleId) {
    redirect("/mobile?screen=access&error=role_required");
  }
  if (!expectedUpdatedAt || idempotencyKey.length < 16) {
    redirect("/mobile?screen=access&error=stale_member_form");
  }

  const principal = await requireCurrentTeamPrincipal();
  const response = await callAdminMutationWithSafeReplay(
    principal,
    `/api/admin/team/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedUpdatedAt,
      },
      body: JSON.stringify({
        expectedUpdatedAt,
        name,
        email: email || null,
        roleId,
        phone: phone || null,
        active: formData.get("active") === "on",
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "member_update_failed");
    redirect(
      `/mobile?screen=access&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=access&account=updated");
}

export async function sendMobileTeamInviteAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const identifierRaw = formData.get("identifier");
  const identifier =
    typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/mobile?screen=access&error=invite_identifier_required");
  }

  const response = await callTeamPublicApi("/api/public/team/request-link", {
    method: "POST",
    body: JSON.stringify({
      identifier,
      redirectPath: "/mobile/auth",
    }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "invite_failed");
    redirect(
      `/mobile?screen=access&error=${encodeURIComponent(message)}` as Route,
    );
  }

  redirect("/mobile?screen=access&invite=sent");
}

export async function runMobilePayoutAction(formData: FormData) {
  await requireMobileOwner();

  const actionRaw = formData.get("action");
  const payoutRunIdRaw = formData.get("payoutRunId");
  const expectedVersionRaw = formData.get("expectedVersion");
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const action = typeof actionRaw === "string" ? actionRaw.trim() : "";
  const payoutRunId =
    typeof payoutRunIdRaw === "string" ? payoutRunIdRaw.trim() : "";
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" && idempotencyKeyRaw.trim()
      ? idempotencyKeyRaw.trim()
      : `commissions:mobile:${action || "unknown"}:${randomUUID()}`;

  let response: Response;
  if (action === "create") {
    response = await callAdminApiForCurrentSession(
      "/api/admin/commissions/payout-runs",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  } else if (action === "lock") {
    if (!payoutRunId)
      redirect("/mobile?screen=owner&error=payout_run_required");
    response = await callAdminApiForCurrentSession(
      `/api/admin/commissions/payout-runs/${encodeURIComponent(payoutRunId)}/lock`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          ...(expectedVersion ? { "If-Match": `"${expectedVersion}"` } : {}),
        },
      },
    );
  } else if (action === "paid") {
    if (!payoutRunId)
      redirect("/mobile?screen=owner&error=payout_run_required");
    response = await callAdminApiForCurrentSession(
      `/api/admin/commissions/payout-runs/${encodeURIComponent(payoutRunId)}/mark-paid`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          ...(expectedVersion ? { "If-Match": `"${expectedVersion}"` } : {}),
        },
      },
    );
  } else {
    redirect("/mobile?screen=owner&error=unknown_payout_action");
  }

  const mutationPayload = (await response
    .clone()
    .json()
    .catch(() => null)) as { ok?: boolean } | null;
  if (!response.ok || mutationPayload?.ok !== true) {
    const message = await readErrorMessage(response, "payout_action_failed");
    redirect(
      `/mobile?screen=owner&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(
    `/mobile?screen=owner&payout=${encodeURIComponent(action)}` as Route,
  );
}

export async function updateMobileContactAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const threadIdRaw = formData.get("threadId");
  const firstNameRaw = formData.get("firstName");
  const lastNameRaw = formData.get("lastName");
  const emailRaw = formData.get("email");
  const phoneRaw = formData.get("phone");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const firstName = typeof firstNameRaw === "string" ? firstNameRaw.trim() : "";
  const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";

  const makeRedirect = (params: Record<string, string>): Route => {
    const searchParams = new URLSearchParams();
    if (threadId) searchParams.set("threadId", threadId);
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    const query = searchParams.toString();
    return (query ? `/mobile?${query}` : "/mobile") as Route;
  };

  if (!contactId) {
    redirect(makeRedirect({ error: "contact_required" }));
  }
  if (!firstName || !lastName) {
    redirect(makeRedirect({ error: "name_required" }));
  }

  const response = await callAdminApiForCurrentSession(
    `/api/admin/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "contact_update_failed");
    redirect(makeRedirect({ error: message }));
  }

  revalidatePath("/mobile");
  redirect(makeRedirect({ contact: "1" }));
}

export async function updateMobileAppointmentStatusAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const statusRaw = formData.get("status");
  const dateRaw = formData.get("date");
  const screenRaw = formData.get("screen");
  const expectedVersion = parseMobileAppointmentVersion(
    formData.get("expectedVersion"),
  );
  const idempotencyKey = parseMobileMutationKey(formData.get("idempotencyKey"));
  const sendCustomerNotification = parseMobileStatusMessageIntent(
    formData,
    "sendCustomerNotification",
  );
  const sendReviewRequest = parseMobileStatusMessageIntent(
    formData,
    "sendReviewRequest",
  );
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const status = typeof statusRaw === "string" ? statusRaw.trim() : "";
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const screen =
    typeof screenRaw === "string" && screenRaw.trim() === "myday"
      ? "myday"
      : "calendar";
  const redirectPath = (
    date
      ? `/mobile?screen=${screen}&date=${encodeURIComponent(date)}`
      : `/mobile?screen=${screen}`
  ) as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!expectedVersion || !idempotencyKey) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("This appointment form is stale. Refresh before making the change.")}` as Route,
    );
  }
  if (sendCustomerNotification === null || sendReviewRequest === null) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The customer-message choices are invalid. Review them before retrying.")}` as Route,
    );
  }
  if (sendCustomerNotification || sendReviewRequest) {
    await requireMobilePermission("messages.send");
  }
  if (
    !["requested", "confirmed", "completed", "no_show", "canceled"].includes(
      status,
    )
  ) {
    redirect(`${redirectPath}&error=invalid_status` as Route);
  }

  const payload: Record<string, unknown> = {
    status,
    expectedVersion,
    sendCustomerNotification,
    sendReviewRequest,
  };
  if (status === "completed") {
    const appointmentTypeRaw = formData.get("appointmentType");
    const appointmentType =
      typeof appointmentTypeRaw === "string"
        ? appointmentTypeRaw.trim().toLowerCase()
        : "";
    const isQuoteOnly =
      appointmentType === "in_person_quote" ||
      appointmentType === "in_person_estimate";
    if (!isQuoteOnly) {
      const preserveFinalTotal = formData.get("preserveFinalTotal") === "1";
      if (!preserveFinalTotal) {
        const finalTotalCents = parseUsdToCents(formData.get("finalTotal"));
        if (finalTotalCents === null) {
          redirect(`${redirectPath}&error=amount_required` as Route);
        }
        payload["finalTotalCents"] = finalTotalCents;
        const expectedFinalTotalCentsRaw = formData.get(
          "expectedFinalTotalCents",
        );
        if (expectedFinalTotalCentsRaw === "null") {
          payload["expectedFinalTotalCents"] = null;
        } else if (
          typeof expectedFinalTotalCentsRaw === "string" &&
          expectedFinalTotalCentsRaw.trim()
        ) {
          const expectedFinalTotalCents = Number(expectedFinalTotalCentsRaw);
          if (
            !Number.isInteger(expectedFinalTotalCents) ||
            expectedFinalTotalCents < 0
          ) {
            redirect(`${redirectPath}&error=invalid_expected_total` as Route);
          }
          payload["expectedFinalTotalCents"] = expectedFinalTotalCents;
        }
        const finalTotalChangeReasonRaw = formData.get(
          "finalTotalChangeReason",
        );
        const finalTotalChangeReason =
          typeof finalTotalChangeReasonRaw === "string"
            ? finalTotalChangeReasonRaw.trim()
            : "";
        if (finalTotalChangeReason) {
          payload["finalTotalChangeReason"] = finalTotalChangeReason;
        }
      }

      const crewMembers = formData
        .getAll("crewMemberId")
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((memberId) => ({ memberId: memberId.trim(), splitBps: 10000 }));
      if (crewMembers.length === 0) {
        redirect(`${redirectPath}&error=crew_required` as Route);
      }
      payload["crewMembers"] = crewMembers;
    }
  }

  let response: Response;
  try {
    response = await callAdminApiForCurrentSession(
      `/api/appointments/${encodeURIComponent(appointmentId)}/status`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The appointment result could not be confirmed. Refresh before retrying; the saved version will prevent a duplicate change.")}` as Route,
    );
  }

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "appointment_update_failed",
    );
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  const envelope = await readTeamMutationSuccess<{
    appointmentId?: unknown;
    status?: unknown;
    version?: unknown;
    calendarSync?: unknown;
    customerNotification?: unknown;
    reviewRequest?: unknown;
  }>(response);
  if (
    !envelope ||
    envelope.data.appointmentId !== appointmentId ||
    envelope.data.status !== status ||
    envelope.receipt.entityType !== "appointment" ||
    envelope.receipt.entityId !== appointmentId ||
    typeof envelope.data.version !== "string" ||
    envelope.data.version.length === 0 ||
    envelope.receipt.version !== envelope.data.version ||
    (envelope.data.calendarSync !== "requested" &&
      envelope.data.calendarSync !== "not_required") ||
    envelope.data.customerNotification !==
      (sendCustomerNotification ? "requested" : "not_requested") ||
    envelope.data.reviewRequest !==
      (sendReviewRequest ? "requested" : "not_requested")
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The appointment service returned an unreadable save receipt. Refresh before retrying; no success is being claimed.")}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(
    `${redirectPath}&appointment=1&customerNotification=${sendCustomerNotification ? "requested" : "not_requested"}&reviewRequest=${sendReviewRequest ? "requested" : "not_requested"}&calendarSync=${envelope.data.calendarSync}` as Route,
  );
}

export async function convertMobileQuoteToJobAction(formData: FormData) {
  await requireMobilePermission("appointments.update");
  await requireMobilePermission("payments.collect");

  const appointmentIdRaw = formData.get("appointmentId");
  const startAtRaw = formData.get("startAt");
  const soldByMemberIdRaw = formData.get("soldByMemberId");
  const expectedSoldByMemberId = parseMobileNullableUuid(
    formData.get("expectedSoldByMemberId"),
  );
  const expectedAssignedSalespersonMemberId = parseMobileNullableUuid(
    formData.get("expectedAssignedSalespersonMemberId"),
  );
  const completionModeRaw = formData.get("completionMode");
  const expectedStatusRaw = formData.get("expectedStatus");
  const dateRaw = formData.get("date");
  const screenRaw = formData.get("screen");
  const expectedVersion = parseMobileAppointmentVersion(
    formData.get("expectedVersion"),
  );
  const idempotencyKey = parseMobileMutationKey(formData.get("idempotencyKey"));
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const startAt = typeof startAtRaw === "string" ? startAtRaw.trim() : "";
  const soldByMemberId =
    typeof soldByMemberIdRaw === "string" ? soldByMemberIdRaw.trim() : "";
  const completionMode =
    typeof completionModeRaw === "string" ? completionModeRaw.trim() : "";
  const expectedStatus =
    typeof expectedStatusRaw === "string" ? expectedStatusRaw.trim() : "";
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const screen =
    typeof screenRaw === "string" && screenRaw.trim() === "myday"
      ? "myday"
      : "calendar";
  const redirectPath = (
    date
      ? `/mobile?screen=${screen}&date=${encodeURIComponent(date)}`
      : `/mobile?screen=${screen}`
  ) as Route;
  const shouldComplete = completionMode === "complete";

  if (!MOBILE_UUID_PATTERN.test(appointmentId)) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!expectedVersion || !idempotencyKey) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("This conversion form is stale. Refresh before trying again.")}` as Route,
    );
  }
  if (!startAt) {
    redirect(`${redirectPath}&error=start_time_required` as Route);
  }
  if (!MOBILE_UUID_PATTERN.test(soldByMemberId)) {
    redirect(`${redirectPath}&error=seller_required` as Route);
  }
  if (
    expectedSoldByMemberId === undefined ||
    expectedAssignedSalespersonMemberId === undefined
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("Seller attribution is stale. Refresh before converting.")}` as Route,
    );
  }
  const sellerBaseline =
    expectedSoldByMemberId ?? expectedAssignedSalespersonMemberId;
  if (sellerBaseline && sellerBaseline !== soldByMemberId) {
    await requireMobilePermission("commissions.manage");
  }
  if (
    !["requested", "confirmed", "completed", "no_show", "canceled"].includes(
      expectedStatus,
    )
  ) {
    redirect(`${redirectPath}&error=invalid_status` as Route);
  }
  if (expectedStatus === "completed") {
    await requireMobilePermission("appointments.override_conflicts");
  }

  const bookingDetailsResult = parseAppointmentBookingFormData(formData);
  if (!bookingDetailsResult.ok) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent(bookingDetailsResult.error)}` as Route,
    );
  }

  let completionPayload: Record<string, unknown> | null = null;
  if (shouldComplete) {
    const finalTotalCents = parseUsdToCents(formData.get("finalTotal"));
    if (finalTotalCents === null) {
      redirect(`${redirectPath}&error=amount_required` as Route);
    }

    const crewMembers = formData
      .getAll("crewMemberId")
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .map((memberId) => ({ memberId: memberId.trim(), splitBps: 10000 }));
    if (crewMembers.length === 0) {
      redirect(`${redirectPath}&error=crew_required` as Route);
    }

    const expectedFinalTotalRaw = formData.get("expectedFinalTotalCents");
    let expectedFinalTotalCents: number | null;
    if (expectedFinalTotalRaw === "null") {
      expectedFinalTotalCents = null;
    } else if (
      typeof expectedFinalTotalRaw === "string" &&
      /^\d{1,10}$/u.test(expectedFinalTotalRaw)
    ) {
      expectedFinalTotalCents = Number(expectedFinalTotalRaw);
    } else {
      redirect(`${redirectPath}&error=invalid_expected_total` as Route);
    }
    const finalTotalChangeReasonRaw = formData.get("finalTotalChangeReason");
    const finalTotalChangeReason =
      typeof finalTotalChangeReasonRaw === "string"
        ? finalTotalChangeReasonRaw.normalize("NFKC").trim()
        : "";
    const isCorrection =
      expectedFinalTotalCents !== null &&
      finalTotalCents !== expectedFinalTotalCents;
    if (isCorrection) {
      await requireMobilePermission("payments.manage");
      if (!finalTotalChangeReason) {
        redirect(`${redirectPath}&error=correction_reason_required` as Route);
      }
    }

    completionPayload = {
      finalTotalCents,
      expectedFinalTotalCents,
      crewMembers,
      ...(isCorrection ? { finalTotalChangeReason } : {}),
    };
  }

  const principal = await requireCurrentTeamPrincipal();
  let convertResponse: Response;
  try {
    convertResponse = await callAdminMutationWithSafeReplay(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId)}/convert`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({
          startAt,
          soldByMemberId,
          expectedSoldByMemberId,
          expectedAssignedSalespersonMemberId,
          quotedTotalCents: bookingDetailsResult.quotedTotalCents,
          bookingDetails: bookingDetailsResult.bookingDetails,
          expectedStatus,
          ...(completionPayload ? { completion: completionPayload } : {}),
        }),
      },
    );
  } catch {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The conversion result could not be confirmed. Refresh before retrying; the saved key prevents duplicate completion.")}` as Route,
    );
  }

  if (!convertResponse.ok) {
    const message = await readErrorMessage(
      convertResponse,
      "quote_convert_failed",
    );
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  const envelope = await readTeamMutationSuccess<{
    appointmentId?: unknown;
    appointmentType?: unknown;
    status?: unknown;
    version?: unknown;
    calendarSync?: unknown;
    completedAtomically?: unknown;
  }>(convertResponse);
  if (
    !envelope ||
    envelope.data.appointmentId !== appointmentId ||
    envelope.data.appointmentType !== "job" ||
    envelope.data.status !== (shouldComplete ? "completed" : "confirmed") ||
    typeof envelope.data.version !== "string" ||
    !["requested", "not_required"].includes(
      String(envelope.data.calendarSync),
    ) ||
    envelope.data.completedAtomically !== shouldComplete ||
    envelope.receipt.entityType !== "appointment" ||
    envelope.receipt.entityId !== appointmentId ||
    envelope.receipt.version !== envelope.data.version
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The appointment service returned an unreadable conversion receipt. Refresh before retrying; no success is being claimed.")}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(
    `${redirectPath}&converted=${shouldComplete ? "completed" : "1"}&calendarSync=${encodeURIComponent(String(envelope.data.calendarSync))}` as Route,
  );
}

export async function addMobileAppointmentNoteAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const dateRaw = formData.get("date");
  const bodyRaw = formData.get("body");
  const expectedVersion = parseMobileAppointmentVersion(
    formData.get("expectedVersion"),
  );
  const idempotencyKey = parseMobileMutationKey(formData.get("idempotencyKey"));
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
  const redirectPath = (
    date
      ? `/mobile?screen=myday&date=${encodeURIComponent(date)}`
      : "/mobile?screen=myday"
  ) as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!body) {
    redirect(`${redirectPath}&error=note_required` as Route);
  }
  if (!expectedVersion || !idempotencyKey) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("This note form is stale. Refresh the appointment before saving it.")}` as Route,
    );
  }

  let response: Response;
  try {
    response = await callAdminApiForCurrentSession(
      `/api/appointments/${encodeURIComponent(appointmentId)}/notes`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The note result could not be confirmed. Refresh before retrying; the saved version will prevent a duplicate note.")}` as Route,
    );
  }

  if (!response.ok) {
    const message = await readErrorMessage(response, "note_save_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  const envelope = await readTeamMutationSuccess<{
    note?: { id?: unknown; appointmentId?: unknown };
    version?: unknown;
  }>(response);
  if (
    !envelope ||
    envelope.data.note?.appointmentId !== appointmentId ||
    typeof envelope.data.note?.id !== "string" ||
    envelope.receipt.entityType !== "appointment_note" ||
    envelope.receipt.entityId !== envelope.data.note.id ||
    typeof envelope.data.version !== "string"
  ) {
    redirect(
      `${redirectPath}&error=${encodeURIComponent("The appointment service returned an unreadable note receipt. Refresh before retrying; no success is being claimed.")}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&note=1` as Route);
}

export async function rescheduleMobileAppointmentAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const preferredDateRaw = formData.get("preferredDate");
  const startTimeRaw = formData.get("startTime");
  const currentDateRaw = formData.get("currentDate");
  const appointmentId =
    typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const preferredDate =
    typeof preferredDateRaw === "string" ? preferredDateRaw.trim() : "";
  const startTime = typeof startTimeRaw === "string" ? startTimeRaw.trim() : "";
  const currentDate =
    typeof currentDateRaw === "string" ? currentDateRaw.trim() : "";
  const redirectPath = (
    currentDate
      ? `/mobile?screen=calendar&date=${encodeURIComponent(currentDate)}`
      : "/mobile?screen=calendar"
  ) as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!preferredDate || !startTime) {
    redirect(`${redirectPath}&error=new_time_required` as Route);
  }

  const response = await callAdminApiForCurrentSession(
    `/api/web/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    {
      method: "POST",
      body: JSON.stringify({
        preferredDate,
        startTime,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "reschedule_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(
    `/mobile?screen=calendar&date=${encodeURIComponent(preferredDate)}&appointment=1` as Route,
  );
}

export async function bookMobileAppointmentAction(formData: FormData) {
  const session = await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const propertyIdRaw = formData.get("propertyId");
  const threadIdRaw = formData.get("threadId");
  const returnToRaw = formData.get("returnTo");
  const appointmentTypeRaw = formData.get("appointmentType");
  const startAtRaw = formData.get("startAt");
  const durationRaw = formData.get("durationMinutes");
  const notesRaw = formData.get("notes");
  const addressLine1Raw = formData.get("addressLine1");
  const addressLine2Raw = formData.get("addressLine2");
  const cityRaw = formData.get("city");
  const stateRaw = formData.get("state");
  const postalCodeRaw = formData.get("postalCode");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  let propertyId =
    typeof propertyIdRaw === "string" ? propertyIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const requestedReturnTo =
    typeof returnToRaw === "string" ? returnToRaw.trim() : "";
  const returnTo = requestedReturnTo ? mobileReturnTo(requestedReturnTo) : null;
  const appointmentType =
    typeof appointmentTypeRaw === "string" &&
    appointmentTypeRaw.trim() === "in_person_quote"
      ? "in_person_quote"
      : "job";
  const startAt = typeof startAtRaw === "string" ? startAtRaw.trim() : "";
  const durationMinutes =
    typeof durationRaw === "string" ? Number(durationRaw) : NaN;
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const addressLine1 =
    typeof addressLine1Raw === "string" ? addressLine1Raw.trim() : "";
  const addressLine2 =
    typeof addressLine2Raw === "string" ? addressLine2Raw.trim() : "";
  const city = typeof cityRaw === "string" ? cityRaw.trim() : "";
  const state = typeof stateRaw === "string" ? stateRaw.trim() : "";
  const postalCode =
    typeof postalCodeRaw === "string" ? postalCodeRaw.trim() : "";
  const threadParam = threadId
    ? `&threadId=${encodeURIComponent(threadId)}`
    : "";
  const errorRedirect = (message: string): Route =>
    returnTo
      ? mobileReturnWithParam(returnTo, "error", message)
      : (`/mobile?${threadParam ? `threadId=${encodeURIComponent(threadId)}&` : ""}error=${encodeURIComponent(message)}` as Route);

  if (!contactId) {
    redirect(errorRedirect("contact_required"));
  }
  if (!startAt) {
    redirect(errorRedirect("start_time_required"));
  }
  const shouldCreateProperty = !propertyId;
  const hasNewAddress = Boolean(
    addressLine1 || addressLine2 || city || state || postalCode,
  );
  const hasCompleteNewAddress = Boolean(
    addressLine1 && city && state && postalCode,
  );
  if (shouldCreateProperty && !hasNewAddress) {
    redirect(errorRedirect("property_required"));
  }
  if (shouldCreateProperty && hasNewAddress && !hasCompleteNewAddress) {
    redirect(errorRedirect("complete_address_required"));
  }

  if (shouldCreateProperty && hasCompleteNewAddress) {
    const propertyResponse = await callAdminApiForCurrentSession(
      `/api/admin/contacts/${encodeURIComponent(contactId)}/properties`,
      {
        method: "POST",
        body: JSON.stringify({
          addressLine1,
          addressLine2: addressLine2 || null,
          city,
          state,
          postalCode,
        }),
      },
    );

    if (!propertyResponse.ok) {
      const message = await readErrorMessage(
        propertyResponse,
        "property_save_failed",
      );
      redirect(errorRedirect(message));
    }

    const propertyPayload = (await propertyResponse
      .json()
      .catch(() => null)) as { property?: { id?: string } } | null;
    propertyId =
      typeof propertyPayload?.property?.id === "string"
        ? propertyPayload.property.id
        : "";
    if (!propertyId) {
      redirect(errorRedirect("property_save_failed"));
    }
  }

  const payload: Record<string, unknown> = {
    contactId,
    propertyId,
    appointmentType,
    startAt,
    durationMinutes:
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? durationMinutes
        : 60,
    travelBufferMinutes: 30,
    soldByMemberId: session.teamMember.id,
    assignedAssociateMemberId: session.teamMember.id,
    source: "mobile",
  };

  if (appointmentType === "job") {
    const bookingDetailsResult = parseAppointmentBookingFormData(formData);
    if (!bookingDetailsResult.ok) {
      redirect(errorRedirect(bookingDetailsResult.error));
    }
    payload["bookingDetails"] = bookingDetailsResult.bookingDetails;
    if (bookingDetailsResult.quotedTotalCents !== null) {
      payload["quotedTotalCents"] = bookingDetailsResult.quotedTotalCents;
    }
  }
  if (notes) payload["notes"] = notes;

  const response = await callAdminApiForCurrentSession(
    "/api/admin/booking/book",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "booking_failed");
    redirect(errorRedirect(message));
  }

  revalidatePath("/mobile");
  if (returnTo) {
    redirect(mobileReturnWithParam(returnTo, "booked", "1"));
  }
  const dayKey = startAt.slice(0, 10);
  const calendarRedirect = dayKey
    ? `/mobile?screen=calendar&date=${encodeURIComponent(dayKey)}&booked=1`
    : "/mobile?screen=calendar&booked=1";
  redirect(calendarRedirect as Route);
}

export async function createMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.write");

  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey)) {
    redirect("/mobile?screen=quotes&error=quote_request_incomplete");
  }

  const contactIdRaw = formData.get("contactId");
  const propertyIdRaw = formData.get("propertyId");
  const contactPropertyRaw = formData.get("contactProperty");
  const notesRaw = formData.get("notes");
  const clientScopeRaw = formData.get("clientScope");
  const jobDurationRaw = formData.get("jobDurationMinutes");
  const depositRateRaw = formData.get("depositRate");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const propertyId =
    typeof propertyIdRaw === "string" ? propertyIdRaw.trim() : "";
  const contactProperty =
    typeof contactPropertyRaw === "string" ? contactPropertyRaw.trim() : "";
  const [combinedContactId, combinedPropertyId] = contactProperty.includes(":")
    ? contactProperty.split(":")
    : ["", ""];
  const resolvedContactId = contactId || combinedContactId || "";
  const resolvedPropertyId = propertyId || combinedPropertyId || "";
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const clientScope =
    typeof clientScopeRaw === "string" ? clientScopeRaw.trim() : "";
  const jobDurationMinutes =
    typeof jobDurationRaw === "string" ? Number(jobDurationRaw) : 120;
  const depositRate =
    typeof depositRateRaw === "string" ? Number(depositRateRaw) : 0;
  const selectedServices = formData
    .getAll("services")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => mobileQuoteServiceIds.has(value));

  const errorRedirect = (message: string): Route =>
    `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route;

  if (!resolvedContactId || !resolvedPropertyId) {
    redirect(errorRedirect("contact_and_property_required"));
  }
  if (!selectedServices.length) {
    redirect(errorRedirect("service_required"));
  }

  const serviceOverrides: Record<string, number> = {};
  for (const serviceId of selectedServices) {
    const amount = parseUsdToDollars(formData.get(`servicePrice:${serviceId}`));
    if (amount === null) {
      redirect(errorRedirect("price_required"));
    }
    serviceOverrides[serviceId] = amount;
  }

  const response = await callAdminApiForCurrentSession("/api/quotes", {
    method: "POST",
    headers: {
      "Idempotency-Key": `${idempotencyKey}:create`,
    },
    body: JSON.stringify({
      confirmation: "create_quote",
      contactId: resolvedContactId,
      propertyId: resolvedPropertyId,
      zoneId: "zone-core",
      selectedServices,
      serviceOverrides,
      expiresInDays: 7,
      jobDurationMinutes:
        Number.isFinite(jobDurationMinutes) && jobDurationMinutes >= 30
          ? Math.trunc(jobDurationMinutes)
          : 120,
      ...(depositRate > 0 ? { depositRate } : {}),
      ...(notes ? { notes } : {}),
      ...(clientScope ? { clientScope } : {}),
    }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "quote_create_failed");
    redirect(errorRedirect(message));
  }
  const envelope = await readTeamMutationSuccess<{
    quote?: { id?: string; revision?: number };
  }>(response);
  if (!envelope) {
    redirect(errorRedirect("quote_success_receipt_invalid"));
  }

  const shouldSend = formData.get("sendQuote") === "on";
  const quoteId = envelope.data.quote?.id ?? "";
  const expectedVersion = envelope.data.quote?.revision;
  if (
    shouldSend &&
    quoteId &&
    Number.isInteger(expectedVersion) &&
    expectedVersion! > 0
  ) {
    const sendResponse = await callAdminApiForCurrentSession(
      `/api/quotes/${encodeURIComponent(quoteId)}/send`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `${idempotencyKey}:send`,
          "If-Match": String(expectedVersion),
        },
        body: JSON.stringify({ confirmation: "send_quote" }),
      },
    );
    const sendEnvelope = await readTeamMutationSuccess(sendResponse);
    if (!sendEnvelope) {
      const message = sendResponse.ok
        ? "quote_send_success_receipt_invalid"
        : await readErrorMessage(sendResponse, "quote_created_send_failed");
      revalidatePath("/mobile");
      redirect(
        `/mobile?screen=quotes&quote=1&error=${encodeURIComponent(message)}` as Route,
      );
    }
  } else if (shouldSend) {
    redirect("/mobile?screen=quotes&quote=1&error=quote_version_missing");
  }

  revalidatePath("/mobile");
  redirect(`/mobile?screen=quotes&quote=${shouldSend ? "sent" : "1"}` as Route);
}

export async function updateMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.update");

  const quoteIdRaw = formData.get("quoteId");
  const expectedVersionRaw = formData.get("expectedVersion");
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const notesRaw = formData.get("notes");
  const clientScopeRaw = formData.get("clientScope");
  const jobDurationRaw = formData.get("jobDurationMinutes");
  const depositRateRaw = formData.get("depositRate");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const clientScope =
    typeof clientScopeRaw === "string" ? clientScopeRaw.trim() : "";
  const jobDurationMinutes =
    typeof jobDurationRaw === "string" ? Number(jobDurationRaw) : null;
  const depositRate =
    typeof depositRateRaw === "string" ? Number(depositRateRaw) : null;
  const selectedServices = formData
    .getAll("services")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => mobileQuoteServiceIds.has(value));

  const errorRedirect = (message: string): Route =>
    `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route;

  if (
    !quoteId ||
    !/^\d+$/u.test(expectedVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey) ||
    formData.get("confirmation") !== "update_quote"
  ) {
    redirect(errorRedirect("quote_required"));
  }
  if (!selectedServices.length) {
    redirect(errorRedirect("service_required"));
  }

  const serviceOverrides: Record<string, number> = {};
  for (const serviceId of selectedServices) {
    const amount = parseUsdToDollars(formData.get(`servicePrice:${serviceId}`));
    if (amount === null) {
      redirect(errorRedirect("price_required"));
    }
    serviceOverrides[serviceId] = amount;
  }

  const response = await callAdminApiForCurrentSession(
    `/api/quotes/${encodeURIComponent(quoteId)}`,
    {
      method: "PATCH",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({
        confirmation: "update_quote",
        zoneId: "zone-core",
        selectedServices,
        serviceOverrides,
        notes: notes || null,
        clientScope: clientScope || null,
        ...(typeof jobDurationMinutes === "number" &&
        Number.isFinite(jobDurationMinutes) &&
        jobDurationMinutes >= 30
          ? { jobDurationMinutes: Math.trunc(jobDurationMinutes) }
          : {}),
        ...(typeof depositRate === "number" &&
        Number.isFinite(depositRate) &&
        depositRate > 0
          ? { depositRate }
          : {}),
      }),
    },
  );

  const updateEnvelope = await readTeamMutationSuccess(response);
  if (!updateEnvelope) {
    const message = response.ok
      ? "quote_update_success_receipt_invalid"
      : await readErrorMessage(response, "quote_update_failed");
    redirect(errorRedirect(message));
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=updated");
}

export async function sendMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.send");

  const quoteIdRaw = formData.get("quoteId");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";
  if (
    !quoteId ||
    !/^\d+$/u.test(expectedVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey) ||
    formData.get("confirmation") !== "send_quote"
  ) {
    redirect("/mobile?screen=quotes&error=quote_request_incomplete");
  }

  const response = await callAdminApiForCurrentSession(
    `/api/quotes/${encodeURIComponent(quoteId)}/send`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({ confirmation: "send_quote" }),
    },
  );

  const sendEnvelope = await readTeamMutationSuccess(response);
  if (!sendEnvelope) {
    const message = response.ok
      ? "quote_send_success_receipt_invalid"
      : await readErrorMessage(response, "quote_send_failed");
    redirect(
      `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=sent");
}

export async function updateMobileQuoteDecisionAction(formData: FormData) {
  await requireMobilePermission("quotes.update");

  const quoteIdRaw = formData.get("quoteId");
  const decisionRaw = formData.get("decision");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  const decision = typeof decisionRaw === "string" ? decisionRaw.trim() : "";
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const idempotencyKeyRaw = formData.get("idempotencyKey");
  const idempotencyKey =
    typeof idempotencyKeyRaw === "string" ? idempotencyKeyRaw.trim() : "";
  if (!quoteId) {
    redirect("/mobile?screen=quotes&error=quote_required");
  }
  if (decision !== "accepted" && decision !== "declined") {
    redirect("/mobile?screen=quotes&error=invalid_quote_decision");
  }
  if (
    !/^\d+$/u.test(expectedVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey) ||
    formData.get("confirmation") !== "set_quote_decision"
  ) {
    redirect("/mobile?screen=quotes&error=quote_request_incomplete");
  }

  const response = await callAdminApiForCurrentSession(
    `/api/quotes/${encodeURIComponent(quoteId)}/decision`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({ decision, confirmation: "set_quote_decision" }),
    },
  );

  const decisionEnvelope = await readTeamMutationSuccess(response);
  if (!decisionEnvelope) {
    const message = response.ok
      ? "quote_decision_success_receipt_invalid"
      : await readErrorMessage(response, "quote_update_failed");
    redirect(
      `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route,
    );
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=updated");
}
