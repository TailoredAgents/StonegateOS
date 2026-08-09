import { NextResponse } from "next/server";
import { isTeamMutationSuccessEnvelope } from "@/app/team/lib/mutation-feedback";

const MAX_EXPENSE_CENTS = 100_000_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_METHODS = new Set([
  "card",
  "cash",
  "ach",
  "check",
  "zelle",
  "other",
]);

type ExpenseFormResult =
  | { ok: true; body: FormData }
  | { ok: false; message: string };

export function parseMoneyToCents(
  value: FormDataEntryValue | null,
): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [dollars, fractional = ""] = normalized.split(".");
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_EXPENSE_CENTS
    ? cents
    : null;
}

export function isoFromDateInput(
  value: FormDataEntryValue | null,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function textValue(
  form: FormData,
  key: string,
  maximum: number,
): string | null {
  const value = form.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maximum
    ? normalized
    : null;
}

export function buildExpenseFormBody(
  form: FormData,
  options: { requireReason?: boolean; includeReceipt?: boolean } = {},
): ExpenseFormResult {
  const amountCents = parseMoneyToCents(form.get("amount"));
  if (amountCents === null) {
    return {
      ok: false,
      message:
        "Enter an amount from $0.01 to $1,000,000 with no more than two decimal places.",
    };
  }
  const paidAt = isoFromDateInput(form.get("paidDate"));
  if (!paidAt) return { ok: false, message: "Choose a valid expense date." };
  const category = textValue(form, "category", 120);
  if (!category) return { ok: false, message: "Category is required." };

  const methodValue = form.get("method");
  const method =
    typeof methodValue === "string" && methodValue.trim().length > 0
      ? methodValue.trim()
      : null;
  if (method && !ALLOWED_METHODS.has(method)) {
    return { ok: false, message: "Choose a valid payment method." };
  }

  const rawCoverageStart = form.get("coverageStartDate");
  const rawCoverageEnd = form.get("coverageEndDate");
  const coverageStartAt =
    typeof rawCoverageStart === "string" && rawCoverageStart.trim().length > 0
      ? isoFromDateInput(rawCoverageStart)
      : null;
  const coverageEndAt =
    typeof rawCoverageEnd === "string" && rawCoverageEnd.trim().length > 0
      ? isoFromDateInput(rawCoverageEnd)
      : null;
  if (
    typeof rawCoverageStart === "string" &&
    rawCoverageStart.trim().length > 0 &&
    !coverageStartAt
  ) {
    return { ok: false, message: "Choose a valid coverage start date." };
  }
  if (
    typeof rawCoverageEnd === "string" &&
    rawCoverageEnd.trim().length > 0 &&
    !coverageEndAt
  ) {
    return { ok: false, message: "Choose a valid coverage end date." };
  }
  if (coverageStartAt && coverageEndAt && coverageEndAt < coverageStartAt) {
    return {
      ok: false,
      message: "Coverage end must be on or after coverage start.",
    };
  }

  const body = new FormData();
  body.set("amountCents", String(amountCents));
  body.set("currency", "USD");
  body.set("category", category);
  body.set("paidAt", paidAt);
  const vendor = textValue(form, "vendor", 240);
  const memo = textValue(form, "memo", 2_000);
  if (vendor) body.set("vendor", vendor);
  if (memo) body.set("memo", memo);
  if (method) body.set("method", method);
  if (coverageStartAt) body.set("coverageStartAt", coverageStartAt);
  if (coverageEndAt) body.set("coverageEndAt", coverageEndAt);

  if (options.requireReason) {
    const reason = textValue(form, "reason", 500);
    if (!reason || reason.length < 3) {
      return {
        ok: false,
        message: "Explain the correction or void in at least three characters.",
      };
    }
    body.set("reason", reason);
  }

  if (options.includeReceipt !== false) {
    const receipt = form.get("receiptFile");
    if (receipt instanceof File && receipt.size > 0) {
      body.set("receiptFile", receipt);
    }
  }
  return { ok: true, body };
}

export function readExpectedVersion(form: FormData): string | null {
  const value = form.get("version");
  return typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())
    ? value.trim()
    : null;
}

export function readIdempotencyKey(form: FormData): string | null {
  const value = form.get("idempotencyKey");
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

export function buildExpenseReasonBody(form: FormData): ExpenseFormResult {
  const reason = textValue(form, "reason", 500);
  if (!reason || reason.length < 3) {
    return {
      ok: false,
      message: "Explain the void in at least three characters.",
    };
  }
  const body = new FormData();
  body.set("reason", reason);
  return { ok: true, body };
}

export function expenseFlashRedirect(
  redirectTo: URL,
  message: string,
  ok: boolean,
): NextResponse {
  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({
    name: ok ? "myst-flash" : "myst-flash-error",
    value: message.slice(0, 500),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: redirectTo.protocol === "https:",
  });
  return response;
}

export async function readExpenseMutationResponse(
  response: Response,
  fallback: string,
  expected: { actorId: string; expenseId?: string },
): Promise<{ ok: boolean; message: string }> {
  type MutationResponseBody = {
    ok?: unknown;
    message?: unknown;
    error?: unknown;
    code?: unknown;
  };
  let parsedBody: unknown = null;
  let body: MutationResponseBody | null = null;
  try {
    const parsed: unknown = await response.json();
    parsedBody = parsed;
    body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as MutationResponseBody)
        : null;
  } catch {
    parsedBody = null;
    body = null;
  }
  if (response.ok) {
    const data =
      body && "data" in body ? (body as Record<string, unknown>)["data"] : null;
    const dataRecord =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const expenseId = dataRecord?.["expenseId"];
    const version = dataRecord?.["version"];
    if (
      isTeamMutationSuccessEnvelope(parsedBody) &&
      typeof expenseId === "string" &&
      UUID_PATTERN.test(expenseId) &&
      (!expected.expenseId || expenseId === expected.expenseId) &&
      Number.isInteger(version) &&
      Number(version) > 0 &&
      parsedBody.receipt.actorId === expected.actorId &&
      UUID_PATTERN.test(parsedBody.receipt.operationId) &&
      parsedBody.receipt.entityType === "expense" &&
      parsedBody.receipt.entityId === expenseId &&
      parsedBody.receipt.version === String(version) &&
      typeof parsedBody.receipt.auditEventId === "string" &&
      UUID_PATTERN.test(parsedBody.receipt.auditEventId)
    ) {
      return { ok: true, message: fallback };
    }
    return {
      ok: false,
      message:
        "The expense service returned an unreadable financial receipt, so no success is being claimed. Refresh before retrying.",
    };
  }
  const serverMessage =
    typeof body?.message === "string" && body.message.trim().length > 0
      ? body.message.trim()
      : null;
  if (serverMessage) return { ok: false, message: serverMessage };
  if (response.status === 401) {
    return {
      ok: false,
      message: "Your session expired. Sign in and try again.",
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      message: "You do not have permission to change expenses.",
    };
  }
  if (response.status === 409) {
    return {
      ok: false,
      message: "This expense changed. Refresh and try again.",
    };
  }
  if (response.status === 422) {
    return { ok: false, message: "Review the expense details and try again." };
  }
  return { ok: false, message: "The expense change was not saved. Try again." };
}
