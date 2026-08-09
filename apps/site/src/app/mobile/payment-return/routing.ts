import type { MutationResult } from "@myst-os/sdk";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERROR_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u;
const MAXIMUM_CALLBACK_VALUE_BYTES = 16 * 1024;
const IOS_CALLBACK_KEYS = new Set([
  "status",
  "state",
  "transaction_id",
  "client_transaction_id",
  "error_code",
  "error_description",
]);
const ANDROID_CALLBACK_KEYS = new Set([
  "com.squareup.pos.SERVER_TRANSACTION_ID",
  "com.squareup.pos.ERROR_CODE",
  "com.squareup.pos.REQUEST_METADATA",
  "com.squareup.pos.CLIENT_TRANSACTION_ID",
  "com.squareup.pos.ERROR_DESCRIPTION",
]);

export type SquareReturnStatus =
  | "verified"
  | "pending_verification"
  | "canceled"
  | "failed"
  | "needs_review";

export type SquareReturnData = {
  status: SquareReturnStatus;
  appointmentId: string;
  attemptId: string;
  errorCode: string | null;
  retryable: boolean;
};

export type SquareReturnFailure = Extract<MutationResult<never>, { ok: false }>;

export type SquareReturnResult =
  | Extract<MutationResult<SquareReturnData>, { ok: true }>
  | SquareReturnFailure;

export type SquareReturnForwardingResult =
  | { ok: true; query: Record<string, string>; state: string }
  | { ok: false; errorCode: "invalid_square_callback" };

const squareSetupErrors = new Set([
  "disabled",
  "illegal_location_id",
  "no_employee_logged_in",
  "not_logged_in",
  "user_id_mismatch",
  "user_not_activated",
  "user_not_active",
  "user_not_logged_in",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const allowedKeys = new Set(allowed);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function validCallbackValue(value: string): boolean {
  const hasUnsafeControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    );
  });
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_CALLBACK_VALUE_BYTES &&
    !hasUnsafeControl
  );
}

function parseJsonWithUniqueObjectKeys(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  const stack: Array<
    { kind: "object"; keys: Set<string> } | { kind: "array" }
  > = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set() });
      if (stack.length > 128) return { ok: false };
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      if (stack.length > 128) return { ok: false };
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    let escaped = false;
    for (index += 1; index < text.length; index += 1) {
      const stringCharacter = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (stringCharacter === "\\") {
        escaped = true;
        continue;
      }
      if (stringCharacter === '"') break;
    }
    if (index >= text.length) return { ok: false };
    let lookahead = index + 1;
    while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
    if (text[lookahead] !== ":") continue;
    const frame = stack.at(-1);
    if (frame?.kind !== "object") continue;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, index + 1)) as unknown;
    } catch {
      return { ok: false };
    }
    if (typeof key !== "string" || frame.keys.has(key)) {
      return { ok: false };
    }
    frame.keys.add(key);
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseIosState(data: string): string | null {
  const unique = parseJsonWithUniqueObjectKeys(data);
  if (!unique.ok) return null;
  const parsed = unique.value;
  if (!isRecord(parsed)) return null;
  if (Object.keys(parsed).some((key) => !IOS_CALLBACK_KEYS.has(key))) {
    return null;
  }
  for (const value of Object.values(parsed)) {
    if (
      value !== null &&
      (typeof value !== "string" || !validCallbackValue(value))
    ) {
      return null;
    }
  }
  const state = parsed["state"];
  const status =
    typeof parsed["status"] === "string"
      ? parsed["status"].trim().toLowerCase()
      : "";
  const transactionId =
    typeof parsed["transaction_id"] === "string"
      ? parsed["transaction_id"].trim()
      : "";
  const errorCode =
    typeof parsed["error_code"] === "string" ? parsed["error_code"].trim() : "";
  return typeof state === "string" &&
    validCallbackValue(state) &&
    ((status === "ok" && transactionId.length > 0 && errorCode.length === 0) ||
      (status === "error" && errorCode.length > 0))
    ? state
    : null;
}

/**
 * The Site rejects ambiguous provider input before forwarding it. The API
 * repeats the validation because this boundary is defense-in-depth, not trust.
 */
export function parseSquareReturnQueryForForwarding(
  searchParams: URLSearchParams,
): SquareReturnForwardingResult {
  const entries = [...searchParams.entries()];
  if (entries.length === 0 || entries.length > ANDROID_CALLBACK_KEYS.size) {
    return { ok: false, errorCode: "invalid_square_callback" };
  }
  const query: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      Object.hasOwn(query, key) ||
      key.length === 0 ||
      key.length > 100 ||
      !validCallbackValue(value)
    ) {
      return { ok: false, errorCode: "invalid_square_callback" };
    }
    query[key] = value;
  }

  if (Object.hasOwn(query, "data")) {
    if (entries.length !== 1) {
      return { ok: false, errorCode: "invalid_square_callback" };
    }
    const state = parseIosState(query["data"]!);
    return state
      ? { ok: true, query, state }
      : { ok: false, errorCode: "invalid_square_callback" };
  }

  if (Object.keys(query).some((key) => !ANDROID_CALLBACK_KEYS.has(key))) {
    return { ok: false, errorCode: "invalid_square_callback" };
  }
  const state = query["com.squareup.pos.REQUEST_METADATA"];
  const transactionId = query["com.squareup.pos.SERVER_TRANSACTION_ID"];
  const errorCode = query["com.squareup.pos.ERROR_CODE"];
  return state && (transactionId || errorCode)
    ? { ok: true, query, state }
    : { ok: false, errorCode: "invalid_square_callback" };
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validFieldErrors(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.keys(value).length <= 16 &&
      Object.entries(value).every(
        ([key, item]) =>
          key.length > 0 &&
          key.length <= 100 &&
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= 1_000,
      ))
  );
}

export function parseSquareReturnResult(
  value: unknown,
  expectedCorrelationId: string,
): SquareReturnResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"] === false) {
    if (
      !hasOnlyKeys(
        value,
        ["ok", "code", "message", "retryable", "fieldErrors"],
        ["ok", "code", "message", "retryable"],
      ) ||
      ![
        "unauthorized",
        "forbidden",
        "conflict",
        "invalid",
        "rate_limited",
        "timeout",
        "provider_failed",
        "internal",
      ].includes(String(value["code"])) ||
      typeof value["message"] !== "string" ||
      value["message"].trim().length === 0 ||
      value["message"].length > 1_000 ||
      typeof value["retryable"] !== "boolean" ||
      !validFieldErrors(value["fieldErrors"])
    ) {
      return null;
    }
    return value as SquareReturnFailure;
  }

  const data = value["data"];
  const receipt = value["receipt"];
  if (
    !hasOnlyKeys(value, ["ok", "data", "receipt"]) ||
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "status",
      "appointmentId",
      "attemptId",
      "errorCode",
      "retryable",
    ]) ||
    !isRecord(receipt) ||
    !hasOnlyKeys(
      receipt,
      [
        "operationId",
        "correlationId",
        "actorId",
        "committedAt",
        "auditEventId",
        "entityType",
        "entityId",
        "version",
        "providerOperationId",
      ],
      [
        "operationId",
        "correlationId",
        "actorId",
        "committedAt",
        "auditEventId",
        "entityType",
        "entityId",
        "version",
      ],
    )
  ) {
    return null;
  }
  if (
    ![
      "verified",
      "pending_verification",
      "canceled",
      "failed",
      "needs_review",
    ].includes(String(data["status"])) ||
    typeof data["appointmentId"] !== "string" ||
    !UUID_PATTERN.test(data["appointmentId"]) ||
    typeof data["attemptId"] !== "string" ||
    !UUID_PATTERN.test(data["attemptId"]) ||
    (data["errorCode"] !== null &&
      (typeof data["errorCode"] !== "string" ||
        !SAFE_ERROR_CODE_PATTERN.test(data["errorCode"]))) ||
    typeof data["retryable"] !== "boolean"
  ) {
    return null;
  }
  if (
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    receipt["correlationId"] !== expectedCorrelationId ||
    typeof receipt["actorId"] !== "string" ||
    !UUID_PATTERN.test(receipt["actorId"]) ||
    !isIsoDate(receipt["committedAt"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "payment_attempt" ||
    receipt["entityId"] !== data["attemptId"] ||
    !isIsoDate(receipt["version"]) ||
    (receipt["providerOperationId"] !== undefined &&
      (typeof receipt["providerOperationId"] !== "string" ||
        receipt["providerOperationId"].trim().length === 0 ||
        receipt["providerOperationId"].length > 500))
  ) {
    return null;
  }
  return value as Extract<MutationResult<SquareReturnData>, { ok: true }>;
}

export function shouldRedirectToSquareSetup(
  result: Pick<SquareReturnData, "status" | "errorCode" | "retryable">,
): boolean {
  if (result.retryable !== true) return false;
  return squareSetupErrors.has(result.errorCode?.trim().toLowerCase() ?? "");
}
