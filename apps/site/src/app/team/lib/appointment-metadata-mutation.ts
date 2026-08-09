import type { AppointmentBookingDetails } from "./booking-details";
import { isTeamMutationSuccessEnvelope } from "./mutation-feedback";

export type AppointmentBookingDetailsMutationData = {
  appointmentId: string;
  quotedTotalCents: number | null;
  bookingDetails: AppointmentBookingDetails;
  changed: boolean;
  version: string;
};

export type AppointmentSoldByMutationData = {
  appointmentId: string;
  appointmentStatus:
    | "requested"
    | "confirmed"
    | "completed"
    | "no_show"
    | "canceled";
  soldByMemberId: string;
  previousSoldByMemberId: string | null;
  changed: boolean;
  commissionsRefreshed: boolean;
  payoutRunIds: string[];
  version: string;
};

export type ExactAppointmentMutationSuccess<T> = {
  ok: true;
  data: T;
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "appointment";
    entityId: string;
    version: string;
  };
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isExactAppointmentVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return sameJson(actual, [...expectedKeys].sort());
}

function hasExactReceipt(
  value: unknown,
  expected: {
    appointmentId: string;
    actorId: string;
    version: string;
  },
): value is ExactAppointmentMutationSuccess<unknown> {
  if (!isTeamMutationSuccessEnvelope(value)) return false;
  const receipt = value.receipt;
  return (
    hasExactKeys(value, ["ok", "data", "receipt"]) &&
    hasExactKeys(receipt, [
      "operationId",
      "correlationId",
      "actorId",
      "committedAt",
      "auditEventId",
      "entityType",
      "entityId",
      "version",
    ]) &&
    isUuid(receipt.operationId) &&
    CORRELATION_ID_PATTERN.test(receipt.correlationId) &&
    receipt.actorId === expected.actorId &&
    isExactAppointmentVersion(receipt.committedAt) &&
    isUuid(receipt.auditEventId) &&
    receipt.entityType === "appointment" &&
    receipt.entityId === expected.appointmentId &&
    receipt.version === expected.version
  );
}

function versionMatchesChange(input: {
  changed: boolean;
  expectedVersion: string;
  resultingVersion: string;
}): boolean {
  if (input.changed) {
    return (
      Date.parse(input.resultingVersion) > Date.parse(input.expectedVersion)
    );
  }
  return input.resultingVersion === input.expectedVersion;
}

export function parseAppointmentBookingDetailsMutationSuccess(
  value: unknown,
  expected: {
    appointmentId: string;
    actorId: string;
    expectedVersion: string;
    quotedTotalCents: number | null;
    bookingDetails: AppointmentBookingDetails;
  },
): ExactAppointmentMutationSuccess<AppointmentBookingDetailsMutationData> | null {
  if (!isRecord(value) || !isRecord(value["data"])) return null;
  const data = value["data"];
  if (
    !hasExactKeys(data, [
      "appointmentId",
      "quotedTotalCents",
      "bookingDetails",
      "changed",
      "version",
    ]) ||
    data["appointmentId"] !== expected.appointmentId ||
    data["quotedTotalCents"] !== expected.quotedTotalCents ||
    !sameJson(data["bookingDetails"], expected.bookingDetails) ||
    typeof data["changed"] !== "boolean" ||
    !isExactAppointmentVersion(data["version"]) ||
    !versionMatchesChange({
      changed: data["changed"],
      expectedVersion: expected.expectedVersion,
      resultingVersion: data["version"],
    }) ||
    !hasExactReceipt(value, {
      appointmentId: expected.appointmentId,
      actorId: expected.actorId,
      version: data["version"],
    })
  ) {
    return null;
  }
  return value as ExactAppointmentMutationSuccess<AppointmentBookingDetailsMutationData>;
}

export function parseAppointmentSoldByMutationSuccess(
  value: unknown,
  expected: {
    appointmentId: string;
    actorId: string;
    expectedVersion: string;
    soldByMemberId: string;
    expectedStatus:
      | "requested"
      | "confirmed"
      | "completed"
      | "no_show"
      | "canceled";
  },
): ExactAppointmentMutationSuccess<AppointmentSoldByMutationData> | null {
  if (!isRecord(value) || !isRecord(value["data"])) return null;
  const data = value["data"];
  const previousSoldByMemberId = data["previousSoldByMemberId"];
  const payoutRunIds = data["payoutRunIds"];
  if (
    !hasExactKeys(data, [
      "appointmentId",
      "appointmentStatus",
      "soldByMemberId",
      "previousSoldByMemberId",
      "changed",
      "commissionsRefreshed",
      "payoutRunIds",
      "version",
    ]) ||
    data["appointmentId"] !== expected.appointmentId ||
    data["appointmentStatus"] !== expected.expectedStatus ||
    data["soldByMemberId"] !== expected.soldByMemberId ||
    !(previousSoldByMemberId === null || isUuid(previousSoldByMemberId)) ||
    typeof data["changed"] !== "boolean" ||
    typeof data["commissionsRefreshed"] !== "boolean" ||
    !Array.isArray(payoutRunIds) ||
    payoutRunIds.some((id) => !isUuid(id)) ||
    new Set(payoutRunIds).size !== payoutRunIds.length ||
    !isExactAppointmentVersion(data["version"]) ||
    !versionMatchesChange({
      changed: data["changed"],
      expectedVersion: expected.expectedVersion,
      resultingVersion: data["version"],
    }) ||
    !hasExactReceipt(value, {
      appointmentId: expected.appointmentId,
      actorId: expected.actorId,
      version: data["version"],
    })
  ) {
    return null;
  }
  const sellerActuallyChanged =
    previousSoldByMemberId !== expected.soldByMemberId;
  if (data["changed"] !== sellerActuallyChanged) return null;
  const completedChange =
    data["changed"] && data["appointmentStatus"] === "completed";
  if (data["commissionsRefreshed"] !== completedChange) return null;
  if (!completedChange && payoutRunIds.length > 0) return null;
  return value as ExactAppointmentMutationSuccess<AppointmentSoldByMutationData>;
}
