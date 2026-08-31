import { DateTime } from "luxon";
import { z } from "zod";
import type { BusinessHoursPolicy, WeekdayKey } from "@/lib/policy";
import {
  PublicQuoteAppointmentSchema,
  PublicQuoteEnvelopeSchema,
  QuoteDocumentSnapshotSchema,
  type QuoteDocumentSnapshot,
} from "@/lib/quote-v2-contract";
import {
  calculateQuoteV2Totals,
  canonicalQuoteJson,
  hashQuoteContent,
  QuoteAggregateStateSchema,
  QuoteCapabilityActionSchema,
  QuoteDomainError,
  QuoteVersionStateSchema,
  resolveQuoteAllowedActions,
  type QuoteCapabilityAction,
  type QuoteTotals,
} from "@/lib/quote-v2-domain";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type QuoteV2PublicCapabilitySnapshot = {
  capabilityId: string;
  capabilityStatus: string;
  recipientRole: string;
  allowedActions: string[];
  readExpiresAt: Date;
  actionExpiresAt: Date | null;
  revokedAt: Date | null;
  quoteId: string;
  quoteNumber: string | null;
  aggregateState: string | null;
  aggregateRevision: number | null;
  currentVersionId: string | null;
  publishedVersionId: string | null;
  acceptedAppointmentId: string | null;
  opportunityId: string | null;
  opportunityStatus: string | null;
  contactId: string;
  contactDeletedAt: Date | null;
  versionId: string;
  versionNumber: number;
  versionState: string;
  documentSnapshot: Record<string, unknown>;
  selectedOptionIds: string[];
  subtotalMinCents: number;
  subtotalMaxCents: number;
  discountMinCents: number;
  discountMaxCents: number;
  feeMinCents: number;
  feeMaxCents: number;
  totalMinCents: number;
  totalMaxCents: number;
  depositCents: number;
  balanceMinCents: number;
  balanceMaxCents: number;
  contentHash: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  proposalPdfHash: string | null;
  hasOpenChangeRequest: boolean;
  hasTerminalResponse: boolean;
  depositCaptured: boolean;
  depositRequiresStaffScheduling: boolean;
  acceptedResponseId: string | null;
  appointment: z.infer<typeof PublicQuoteAppointmentSchema> | null;
  attachments: Array<{
    id: string;
    purpose:
      | "scope_evidence"
      | "site_plan"
      | "specification"
      | "terms"
      | "other";
    caption: string | null;
    fileName: string;
    mediaType:
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "image/heic"
      | "application/pdf";
    displayOrder: number;
  }>;
};

export class QuoteV2PublicStateError extends Error {
  readonly code: "gone" | "conflict" | "invalid" | "provider_unavailable";
  readonly fieldErrors: Record<string, string>;

  constructor(
    code: QuoteV2PublicStateError["code"],
    message: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "QuoteV2PublicStateError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export type QuoteV2AppointmentBinding = {
  id: string;
  quoteVersionId: string | null;
  quoteResponseId: string | null;
  status: string;
  startAt: Date | null;
  durationMinutes: number;
  schedulingTimezone: string | null;
  promisedArrivalStartAt: Date | null;
  promisedArrivalEndAt: Date | null;
};

function appointmentProjectionUnavailable(): never {
  throw new QuoteV2PublicStateError(
    "provider_unavailable",
    "The booked appointment details cannot be loaded right now.",
  );
}

function publicAppointmentStatus(
  status: string,
): "requested" | "confirmed" | "canceled" | "completed" {
  if (
    status === "requested" ||
    status === "confirmed" ||
    status === "completed"
  ) {
    return status;
  }
  // `no_show` is an internal operational distinction. Customer proposal links
  // safely present it as a past appointment requiring scheduling support.
  if (status === "canceled" || status === "no_show") return "canceled";
  return appointmentProjectionUnavailable();
}

/**
 * Produces the only customer-visible appointment shape after proving that the
 * mutable appointment remains bound to the quote pointer, exact immutable
 * version, and exact accepted response. Unknown or partial evidence fails
 * closed instead of falling back to a generic "Booked" claim.
 */
export function resolveQuoteV2PublicAppointment(input: {
  acceptedAppointmentId: string | null;
  acceptedResponseId: string | null;
  acceptedResponseAppointmentId: string | null;
  expectedVersionId: string;
  appointment: QuoteV2AppointmentBinding | null;
}): z.infer<typeof PublicQuoteAppointmentSchema> | null {
  if (!input.acceptedAppointmentId) {
    if (input.appointment || input.acceptedResponseAppointmentId) {
      appointmentProjectionUnavailable();
    }
    return null;
  }
  const appointment = input.appointment;
  if (
    !input.acceptedResponseId ||
    input.acceptedResponseAppointmentId !== input.acceptedAppointmentId ||
    !appointment ||
    appointment.id !== input.acceptedAppointmentId ||
    appointment.quoteVersionId !== input.expectedVersionId ||
    appointment.quoteResponseId !== input.acceptedResponseId
  ) {
    return appointmentProjectionUnavailable();
  }
  if (
    !appointment.startAt ||
    Number.isNaN(appointment.startAt.getTime()) ||
    !Number.isSafeInteger(appointment.durationMinutes) ||
    appointment.durationMinutes < 1 ||
    appointment.durationMinutes > 30 * 24 * 60
  ) {
    return appointmentProjectionUnavailable();
  }
  const timezone = appointment.schedulingTimezone?.trim() ?? "";
  if (
    !timezone ||
    timezone.length > 64 ||
    !DateTime.fromJSDate(appointment.startAt, { zone: "utc" }).setZone(timezone)
      .isValid
  ) {
    return appointmentProjectionUnavailable();
  }
  const arrivalStart = appointment.promisedArrivalStartAt;
  const arrivalEnd = appointment.promisedArrivalEndAt;
  if (Boolean(arrivalStart) !== Boolean(arrivalEnd)) {
    return appointmentProjectionUnavailable();
  }
  if (
    arrivalStart &&
    arrivalEnd &&
    (Number.isNaN(arrivalStart.getTime()) ||
      Number.isNaN(arrivalEnd.getTime()) ||
      arrivalEnd <= arrivalStart)
  ) {
    return appointmentProjectionUnavailable();
  }
  const endAt = new Date(
    appointment.startAt.getTime() + appointment.durationMinutes * 60_000,
  );
  return PublicQuoteAppointmentSchema.parse({
    id: appointment.id,
    status: publicAppointmentStatus(appointment.status),
    startAt: appointment.startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone,
    durationMinutes: appointment.durationMinutes,
    promisedArrivalWindow:
      arrivalStart && arrivalEnd
        ? {
            startAt: arrivalStart.toISOString(),
            endAt: arrivalEnd.toISOString(),
          }
        : null,
  });
}

function earliestDate(first: Date | null, second: Date | null): Date | null {
  if (!first) return second;
  if (!second) return first;
  return first <= second ? first : second;
}

function parseCapabilityActions(actions: string[]): QuoteCapabilityAction[] {
  const parsed = z.array(QuoteCapabilityActionSchema).safeParse(actions);
  if (!parsed.success) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "This proposal link is temporarily unavailable.",
    );
  }
  return parsed.data;
}

export function quoteV2PublicAllowedActions(
  row: QuoteV2PublicCapabilitySnapshot,
  now = new Date(),
): QuoteCapabilityAction[] {
  if (
    row.capabilityStatus === "revoked" ||
    row.revokedAt ||
    row.readExpiresAt <= now
  ) {
    return [];
  }
  const aggregate = QuoteAggregateStateSchema.safeParse(row.aggregateState);
  const version = QuoteVersionStateSchema.safeParse(row.versionState);
  if (!aggregate.success || !version.success) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "This proposal link is temporarily unavailable.",
    );
  }

  const capabilityActions = parseCapabilityActions(row.allowedActions);
  const actions =
    row.capabilityStatus === "active"
      ? capabilityActions
      : capabilityActions.filter(
          (action): action is QuoteCapabilityAction =>
            action === "view" || action === "pdf",
        );
  const effectiveActionExpiresAt =
    row.aggregateState === "accepted" && row.versionState === "accepted"
      ? row.actionExpiresAt
      : earliestDate(row.actionExpiresAt, row.expiresAt);
  const resolved = resolveQuoteAllowedActions({
    aggregateState: aggregate.data,
    versionState: version.data,
    capabilityActions: actions,
    actionExpiresAt: effectiveActionExpiresAt,
    readExpiresAt: row.readExpiresAt,
    revokedAt: row.revokedAt,
    hasOpenChangeRequest: row.hasOpenChangeRequest,
    requiresDeposit: row.depositCents > 0,
    depositCaptured: row.depositCaptured,
    schedulingMode: QuoteDocumentSnapshotSchema.parse(row.documentSnapshot)
      .schedulingMode,
    now,
  });
  if (canRequestQuoteV2Refresh(row, now) && !resolved.includes("refresh")) {
    resolved.push("refresh");
  }
  return resolved.filter((action) => {
    if (
      row.acceptedAppointmentId &&
      (action === "availability" ||
        action === "hold" ||
        action === "checkout" ||
        action === "book")
    ) {
      return false;
    }
    if (
      row.depositRequiresStaffScheduling &&
      (action === "checkout" || action === "book")
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Refresh is intentionally separate from ordinary proposal actions. It may be
 * exercised only while the exact immutable proposal remains the quote's
 * current published version and its read capability is still retained.
 * Existing signer links issued before `refresh` was introduced inherit this
 * one narrow action from their prior `change` grant.
 */
export function canRequestQuoteV2Refresh(
  row: QuoteV2PublicCapabilitySnapshot,
  now = new Date(),
): boolean {
  if (
    row.capabilityStatus !== "active" ||
    row.revokedAt ||
    row.readExpiresAt <= now ||
    row.recipientRole !== "signer" ||
    row.contactDeletedAt ||
    row.aggregateState !== "open" ||
    (row.versionState !== "issued" && row.versionState !== "expired") ||
    !row.expiresAt ||
    row.expiresAt > now ||
    row.currentVersionId !== row.versionId ||
    row.publishedVersionId !== row.versionId ||
    row.opportunityStatus !== "open" ||
    row.hasOpenChangeRequest ||
    row.hasTerminalResponse
  ) {
    return false;
  }
  const granted = parseCapabilityActions(row.allowedActions);
  return granted.includes("refresh") || granted.includes("change");
}

function displayState(
  row: QuoteV2PublicCapabilitySnapshot,
  allowedActions: readonly QuoteCapabilityAction[],
  now: Date,
): string {
  if (row.appointment?.status === "requested") return "Appointment requested";
  if (row.appointment?.status === "confirmed") return "Booked";
  if (row.appointment?.status === "canceled") return "Appointment canceled";
  if (row.appointment?.status === "completed") return "Service completed";
  if (row.versionState === "superseded") return "Superseded · View only";
  if (row.versionState === "declined") return "Declined · View only";
  if (row.versionState === "voided") return "Voided · View only";
  if (row.versionState === "accepted") {
    if (row.depositRequiresStaffScheduling) {
      return "Deposit received · Scheduling confirmation needed";
    }
    if (row.depositCents > 0 && !row.depositCaptured) {
      return "Approved · Deposit due";
    }
    if (row.depositCents > 0 && row.depositCaptured) {
      return "Deposit received · Scheduling";
    }
    return "Approved";
  }
  if (row.hasOpenChangeRequest) return "Changes requested";
  if (row.expiresAt && row.expiresAt <= now) return "Expired · View only";
  if (allowedActions.includes("accept")) return "Awaiting your approval";
  return "View only";
}

export function buildQuoteV2PublicEnvelope(
  row: QuoteV2PublicCapabilitySnapshot,
  now = new Date(),
): z.infer<typeof PublicQuoteEnvelopeSchema> {
  if (
    row.capabilityStatus === "revoked" ||
    row.revokedAt ||
    row.readExpiresAt <= now
  ) {
    throw new QuoteV2PublicStateError(
      "gone",
      "This proposal link is no longer available.",
    );
  }
  if (
    Boolean(row.acceptedAppointmentId) !== Boolean(row.appointment) ||
    (row.appointment &&
      (row.appointment.id !== row.acceptedAppointmentId ||
        !row.acceptedResponseId))
  ) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The booked appointment details cannot be loaded right now.",
    );
  }
  if (
    !row.quoteNumber ||
    !row.issuedAt ||
    !row.expiresAt ||
    !row.contentHash ||
    !HASH_PATTERN.test(row.contentHash)
  ) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The issued proposal cannot be loaded right now.",
    );
  }
  const document = QuoteDocumentSnapshotSchema.safeParse(row.documentSnapshot);
  if (!document.success) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The issued proposal cannot be loaded right now.",
    );
  }
  const allowedActions = quoteV2PublicAllowedActions(row, now);
  if (!allowedActions.includes("view")) {
    throw new QuoteV2PublicStateError(
      "gone",
      "This proposal link is no longer available.",
    );
  }
  return PublicQuoteEnvelopeSchema.parse({
    quoteId: row.quoteId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    quoteNumber: row.quoteNumber,
    lifecycleState: row.versionState,
    displayState: displayState(row, allowedActions, now),
    document: document.data,
    selectedOptionIds: [...row.selectedOptionIds],
    totals: {
      subtotalMinCents: row.subtotalMinCents,
      subtotalMaxCents: row.subtotalMaxCents,
      discountMinCents: row.discountMinCents,
      discountMaxCents: row.discountMaxCents,
      feeMinCents: row.feeMinCents,
      feeMaxCents: row.feeMaxCents,
      totalMinCents: row.totalMinCents,
      totalMaxCents: row.totalMaxCents,
      depositCents: row.depositCents,
      balanceMinCents: row.balanceMinCents,
      balanceMaxCents: row.balanceMaxCents,
    },
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    allowedActions,
    attachments: row.attachments,
    acceptedResponseId: row.acceptedResponseId,
    acceptedAppointmentId: row.acceptedAppointmentId,
    appointment: row.appointment,
  });
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function quoteV2ConsentText(input: {
  document: QuoteDocumentSnapshot;
  quoteNumber: string;
  versionNumber: number;
  totals: QuoteTotals;
}): string {
  const reference = `proposal ${input.quoteNumber}, version ${input.versionNumber}`;
  if (input.document.documentType === "fixed_quote") {
    return `I approve ${reference} for the firm scoped total of ${usd(input.totals.totalMinCents)} and agree to its terms and change-order rules.`;
  }
  if (input.document.documentType === "estimate") {
    return `I approve ${reference} with the non-binding estimated total of ${usd(input.totals.totalMinCents)} and acknowledge its stated pricing, finalization, and change-order rules.`;
  }
  return `I approve ${reference} with the non-binding estimated range of ${usd(input.totals.totalMinCents)}–${usd(input.totals.totalMaxCents)} and acknowledge its stated pricing, finalization, and change-order rules.`;
}

export type QuoteV2AcceptanceEvidence = {
  document: QuoteDocumentSnapshot;
  totals: QuoteTotals;
  selectedOptionIds: string[];
  signerSnapshot: Record<string, unknown>;
  configurationSnapshot: Record<string, unknown>;
  consentText: string;
  consentVersion: string;
  configurationHash: string;
  consentHash: string;
  contentHash: string;
  issuedPdfHash: string;
};

export function prepareQuoteV2AcceptanceEvidence(input: {
  row: Pick<
    QuoteV2PublicCapabilitySnapshot,
    | "documentSnapshot"
    | "quoteNumber"
    | "versionNumber"
    | "contentHash"
    | "proposalPdfHash"
  >;
  selectedOptionIds: readonly string[];
  signer: {
    name: string;
    title: string;
    company?: string | null;
    authorityAffirmed: true;
  };
  consentVersion: string;
  consentAffirmed: true;
  requestedStartAt?: string | null;
  holdId?: string | null;
}): QuoteV2AcceptanceEvidence {
  const document = QuoteDocumentSnapshotSchema.parse(
    input.row.documentSnapshot,
  );
  if (document.terms.consentVersion !== input.consentVersion) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The proposal consent language changed. Refresh before approving.",
    );
  }
  if (
    !input.row.quoteNumber ||
    !input.row.contentHash ||
    !HASH_PATTERN.test(input.row.contentHash) ||
    !input.row.proposalPdfHash ||
    !HASH_PATTERN.test(input.row.proposalPdfHash)
  ) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The issued proposal evidence is unavailable. Please try again later.",
    );
  }

  let totals: QuoteTotals;
  try {
    totals = calculateQuoteV2Totals(document.pricing, input.selectedOptionIds);
  } catch (error) {
    if (error instanceof QuoteDomainError) {
      throw new QuoteV2PublicStateError(
        "invalid",
        error.message,
        error.fieldErrors,
      );
    }
    throw error;
  }
  const selectedOptionIds = [...totals.selectedOptionIds].sort();
  const signerSnapshot = {
    name: input.signer.name,
    title: input.signer.title,
    company: input.signer.company ?? null,
    authorityAffirmed: true,
  };
  const configurationSnapshot = {
    documentType: document.documentType,
    schedulingMode: document.schedulingMode,
    selectedOptionIds,
    requestedStartAt: input.requestedStartAt ?? null,
    holdId: input.holdId ?? null,
    totals: {
      totalMinCents: totals.totalMinCents,
      totalMaxCents: totals.totalMaxCents,
      depositCents: totals.depositCents,
      balanceMinCents: totals.balanceMinCents,
      balanceMaxCents: totals.balanceMaxCents,
    },
  };
  const consentText = quoteV2ConsentText({
    document,
    quoteNumber: input.row.quoteNumber,
    versionNumber: input.row.versionNumber,
    totals,
  });
  return {
    document,
    totals,
    selectedOptionIds,
    signerSnapshot,
    configurationSnapshot,
    consentText,
    consentVersion: input.consentVersion,
    configurationHash: hashQuoteContent(configurationSnapshot),
    consentHash: hashQuoteContent({
      text: consentText,
      version: input.consentVersion,
      affirmed: input.consentAffirmed,
    }),
    contentHash: input.row.contentHash,
    issuedPdfHash: input.row.proposalPdfHash,
  };
}

export function quoteV2PublicRequestHash(input: unknown): string {
  return hashQuoteContent(input);
}

export function safeQuoteV2ResponseMetadata(input: {
  requestHash: string;
  capabilityId: string;
  evidenceQuality: "exact" | "basic";
}): Record<string, unknown> {
  return {
    requestHash: input.requestHash,
    capabilityId: input.capabilityId,
    evidenceQuality: input.evidenceQuality,
  };
}

const WEEKDAY_BY_NUMBER: Record<number, WeekdayKey> = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
  7: "sunday",
};

function localTime(day: DateTime, value: string): DateTime | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/** Adds service hours across configured local working windows. */
export function addQuoteChangeBusinessHours(input: {
  at: Date;
  hours: number;
  policy: BusinessHoursPolicy;
}): Date {
  if (!Number.isFinite(input.hours) || input.hours <= 0 || input.hours > 40) {
    throw new Error("Business-hour duration must be between 0 and 40 hours.");
  }
  let cursor = DateTime.fromJSDate(input.at, { zone: input.policy.timezone });
  if (!cursor.isValid) throw new Error("Business timezone is invalid.");
  let remainingMs = input.hours * 60 * 60 * 1_000;

  for (let dayOffset = 0; dayOffset < 45; dayOffset += 1) {
    const localDay: DateTime = cursor.startOf("day");
    const weekday = WEEKDAY_BY_NUMBER[localDay.weekday];
    const windows = weekday ? input.policy.weekly[weekday] : [];
    const intervals = windows
      .map((window) => ({
        start: localTime(localDay, window.start),
        end: localTime(localDay, window.end),
      }))
      .filter((interval): interval is { start: DateTime; end: DateTime } =>
        Boolean(
          interval.start?.isValid &&
            interval.end?.isValid &&
            interval.end > interval.start,
        ),
      )
      .sort((left, right) => left.start.toMillis() - right.start.toMillis());

    for (const interval of intervals) {
      const start = cursor > interval.start ? cursor : interval.start;
      if (start >= interval.end) continue;
      const availableMs = interval.end.toMillis() - start.toMillis();
      if (remainingMs <= availableMs) {
        return start.plus({ milliseconds: remainingMs }).toUTC().toJSDate();
      }
      remainingMs -= availableMs;
    }
    cursor = localDay.plus({ days: 1 });
  }
  throw new Error("Business-hour policy has insufficient availability.");
}

export function canonicalQuoteV2PublicValue(value: unknown): string {
  return canonicalQuoteJson(value);
}
