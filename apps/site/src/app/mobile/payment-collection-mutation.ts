import type { MutationResult } from "@myst-os/sdk";
import type { OfflinePaymentSummary } from "./lib/offline-media";

export type SquareAttemptMutationData = {
  appointmentId: string;
  attemptId: string;
  clientRequestId: string;
  platform: "ios" | "android";
  amountCents: number;
  status: "launched";
  expiresAt: string;
  launchUrl: string;
  paymentSummary: OfflinePaymentSummary;
  version: string;
};

export type ManualPaymentMutationData = {
  appointmentId: string;
  paymentId: string;
  clientRequestId: string;
  tenderType: "cash" | "check";
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  status: "completed";
  paymentSummary: OfflinePaymentSummary;
  version: string;
};

export type PaymentCollectionMutationFailure = Extract<
  MutationResult<never>,
  { ok: false }
> & {
  current?: { version: string };
  attemptId?: string;
};

export type SquareAttemptMutationResult =
  | Extract<MutationResult<SquareAttemptMutationData>, { ok: true }>
  | PaymentCollectionMutationFailure;
export type ManualPaymentMutationResult =
  | Extract<MutationResult<ManualPaymentMutationData>, { ok: true }>
  | PaymentCollectionMutationFailure;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
const PAYMENT_STATUSES = new Set([
  "unknown",
  "unpaid",
  "partial",
  "paid",
  "refunded",
  "needs_review",
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
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

function isNullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || isNonnegativeInteger(value);
}

function isNonemptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_000
  );
}

function isHttpUrlOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isPaymentSummary(value: unknown): value is OfflinePaymentSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "jobTotalCents",
      "paidTowardJobCents",
      "tipCents",
      "refundedCents",
      "balanceCents",
      "activeAttemptId",
      "latestReceiptUrl",
    ])
  ) {
    return false;
  }
  return (
    typeof value["status"] === "string" &&
    PAYMENT_STATUSES.has(value["status"]) &&
    isNullableNonnegativeInteger(value["jobTotalCents"]) &&
    isNonnegativeInteger(value["paidTowardJobCents"]) &&
    isNonnegativeInteger(value["tipCents"]) &&
    isNonnegativeInteger(value["refundedCents"]) &&
    isNullableNonnegativeInteger(value["balanceCents"]) &&
    (value["activeAttemptId"] === null || isUuid(value["activeAttemptId"])) &&
    isHttpUrlOrNull(value["latestReceiptUrl"])
  );
}

function fieldsAreValid(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.keys(value).length <= 16 &&
      Object.entries(value).every(
        ([key, message]) =>
          key.length > 0 &&
          key.length <= 100 &&
          typeof message === "string" &&
          message.trim().length > 0 &&
          message.length <= 1_000,
      ))
  );
}

function parseFailure(
  value: Record<string, unknown>,
): PaymentCollectionMutationFailure | null {
  if (
    value["ok"] !== false ||
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
    !fieldsAreValid(value["fieldErrors"])
  ) {
    return null;
  }
  const current = value["current"];
  if (
    current !== undefined &&
    (!isRecord(current) ||
      !hasOnlyKeys(current, ["version"]) ||
      !isIsoDate(current["version"]))
  ) {
    return null;
  }
  if (value["attemptId"] !== undefined && !isUuid(value["attemptId"])) {
    return null;
  }
  return value as PaymentCollectionMutationFailure;
}

function receiptIsValid(
  value: unknown,
  input: {
    entityType: "payment_attempt" | "payment";
    entityId: string;
    version: string;
  },
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
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
    return false;
  }
  return (
    isUuid(value["operationId"]) &&
    isUuid(value["correlationId"]) &&
    isUuid(value["actorId"]) &&
    isIsoDate(value["committedAt"]) &&
    isUuid(value["auditEventId"]) &&
    value["entityType"] === input.entityType &&
    value["entityId"] === input.entityId &&
    value["version"] === input.version
  );
}

function launchUrlMatchesPlatform(
  value: unknown,
  platform: "ios" | "android",
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    (platform === "ios"
      ? value.startsWith("square-commerce-v1://payment/create?")
      : value.startsWith("intent:#Intent;"))
  );
}

export function parseSquareAttemptMutationResult(
  value: unknown,
  expectedAppointmentId: string,
): SquareAttemptMutationResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"] === false) return parseFailure(value);
  const data = value["data"];
  if (
    !hasOnlyKeys(value, ["ok", "data", "receipt"]) ||
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "appointmentId",
      "attemptId",
      "clientRequestId",
      "platform",
      "amountCents",
      "status",
      "expiresAt",
      "launchUrl",
      "paymentSummary",
      "version",
    ]) ||
    !isUuid(expectedAppointmentId) ||
    data["appointmentId"] !== expectedAppointmentId ||
    !isUuid(data["attemptId"]) ||
    !isUuid(data["clientRequestId"]) ||
    (data["platform"] !== "ios" && data["platform"] !== "android") ||
    !isNonnegativeInteger(data["amountCents"]) ||
    data["amountCents"] <= 0 ||
    data["status"] !== "launched" ||
    !isIsoDate(data["expiresAt"]) ||
    !launchUrlMatchesPlatform(data["launchUrl"], data["platform"]) ||
    !isPaymentSummary(data["paymentSummary"]) ||
    data["paymentSummary"].activeAttemptId !== data["attemptId"] ||
    data["paymentSummary"].balanceCents !== data["amountCents"] ||
    !isIsoDate(data["version"]) ||
    !receiptIsValid(value["receipt"], {
      entityType: "payment_attempt",
      entityId: data["attemptId"],
      version: data["version"],
    })
  ) {
    return null;
  }
  return value as Extract<
    MutationResult<SquareAttemptMutationData>,
    { ok: true }
  >;
}

export function parseManualPaymentMutationResult(
  value: unknown,
  expectedAppointmentId: string,
): ManualPaymentMutationResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"] === false) return parseFailure(value);
  const data = value["data"];
  if (
    !hasOnlyKeys(value, ["ok", "data", "receipt"]) ||
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "appointmentId",
      "paymentId",
      "clientRequestId",
      "tenderType",
      "jobAmountCents",
      "tipCents",
      "totalAmountCents",
      "status",
      "paymentSummary",
      "version",
    ]) ||
    !isUuid(expectedAppointmentId) ||
    data["appointmentId"] !== expectedAppointmentId ||
    !isUuid(data["paymentId"]) ||
    !isUuid(data["clientRequestId"]) ||
    (data["tenderType"] !== "cash" && data["tenderType"] !== "check") ||
    !isNonnegativeInteger(data["jobAmountCents"]) ||
    data["jobAmountCents"] <= 0 ||
    !isNonnegativeInteger(data["tipCents"]) ||
    !isNonnegativeInteger(data["totalAmountCents"]) ||
    data["totalAmountCents"] !== data["jobAmountCents"] + data["tipCents"] ||
    data["status"] !== "completed" ||
    !isPaymentSummary(data["paymentSummary"]) ||
    data["paymentSummary"].status !== "paid" ||
    data["paymentSummary"].balanceCents !== 0 ||
    data["paymentSummary"].activeAttemptId !== null ||
    !isIsoDate(data["version"]) ||
    !receiptIsValid(value["receipt"], {
      entityType: "payment",
      entityId: data["paymentId"],
      version: data["version"],
    })
  ) {
    return null;
  }
  return value as Extract<
    MutationResult<ManualPaymentMutationData>,
    { ok: true }
  >;
}
