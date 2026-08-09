import type { MutationResult } from "@myst-os/sdk";

export type FinalTotalMutationData = {
  appointmentId: string;
  finalTotalCents: number;
  previousFinalTotalCents: number | null;
  paidTowardJobCents: number;
  paymentLocked: boolean;
  changed: boolean;
  version: string;
};

export type FinalTotalMutationFailure = Extract<
  MutationResult<never>,
  { ok: false }
> & {
  current?: { finalTotalCents: number | null; version: string };
  attemptId?: string;
};

export type FinalTotalMutationResult =
  | Extract<MutationResult<FinalTotalMutationData>, { ok: true }>
  | FinalTotalMutationFailure;

const ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "conflict",
  "invalid",
  "rate_limited",
  "timeout",
  "provider_failed",
  "internal",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const allowedSet = new Set(allowed);
  return (
    Object.keys(value).every((key) => allowedSet.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
  );
}

function isNullableCents(value: unknown): value is number | null {
  return value === null || isNonnegativeInteger(value);
}

function isNonemptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_000
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function fieldErrorsAreValid(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.keys(value).length <= 16 &&
      Object.keys(value).every((key) => key.length > 0 && key.length <= 100) &&
      Object.values(value).every(
        (entry) =>
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          entry.length <= 1_000,
      ))
  );
}

export function parseFinalTotalMutationResult(
  value: unknown,
  expectedAppointmentId: string,
): FinalTotalMutationResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;

  if (value["ok"] === false) {
    if (
      !hasOnlyKeys(
        value,
        [
          "ok",
          "code",
          "message",
          "retryable",
          "fieldErrors",
          "current",
          "attemptId",
        ],
        ["ok", "code", "message", "retryable"],
      ) ||
      typeof value["code"] !== "string" ||
      !ERROR_CODES.has(value["code"]) ||
      !isNonemptyString(value["message"]) ||
      typeof value["retryable"] !== "boolean" ||
      !fieldErrorsAreValid(value["fieldErrors"])
    ) {
      return null;
    }
    const current = value["current"];
    if (
      current !== undefined &&
      (!isRecord(current) ||
        !hasOnlyKeys(current, ["finalTotalCents", "version"]) ||
        !isNullableCents(current["finalTotalCents"]) ||
        !isIsoDate(current["version"]))
    ) {
      return null;
    }
    if (value["attemptId"] !== undefined && !isUuid(value["attemptId"])) {
      return null;
    }
    return value as FinalTotalMutationFailure;
  }

  const data = value["data"];
  const receipt = value["receipt"];
  if (
    !hasOnlyKeys(value, ["ok", "data", "receipt"]) ||
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "appointmentId",
      "finalTotalCents",
      "previousFinalTotalCents",
      "paidTowardJobCents",
      "paymentLocked",
      "changed",
      "version",
    ]) ||
    !isRecord(receipt) ||
    !hasOnlyKeys(receipt, [
      "operationId",
      "correlationId",
      "actorId",
      "committedAt",
      "auditEventId",
      "entityType",
      "entityId",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(expectedAppointmentId) ||
    data["appointmentId"] !== expectedAppointmentId ||
    !isNonnegativeInteger(data["finalTotalCents"]) ||
    !isNullableCents(data["previousFinalTotalCents"]) ||
    !isNonnegativeInteger(data["paidTowardJobCents"]) ||
    typeof data["paymentLocked"] !== "boolean" ||
    typeof data["changed"] !== "boolean" ||
    !isIsoDate(data["version"])
  ) {
    return null;
  }
  if (
    !isUuid(receipt["operationId"]) ||
    !isUuid(receipt["correlationId"]) ||
    !isUuid(receipt["actorId"]) ||
    !isIsoDate(receipt["committedAt"]) ||
    !isUuid(receipt["auditEventId"]) ||
    receipt["entityType"] !== "appointment" ||
    !isUuid(receipt["entityId"]) ||
    receipt["entityId"] !== expectedAppointmentId ||
    receipt["version"] !== data["version"]
  ) {
    return null;
  }
  return value as Extract<MutationResult<FinalTotalMutationData>, { ok: true }>;
}
