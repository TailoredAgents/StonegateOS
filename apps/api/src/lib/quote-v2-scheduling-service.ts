import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  auditLogs,
  calendarSyncState,
  getDb,
  outboxEvents,
  paymentAttempts,
  payments,
  publicQuoteMutationReceipts,
  quoteActivityEvents,
  quoteResponses,
  quotes,
  scheduleBlocks,
  salesOpportunities,
  type DatabaseClient,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { resolveAutomaticAppointmentStatusForMedia } from "@/lib/appointment-media";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { getCalendarConfig, isGoogleCalendarEnabled } from "@/lib/calendar";
import {
  getBookingRulesPolicy,
  getBusinessHourWindowsForDate,
  getBusinessHoursPolicy,
  isWithinBusinessHours,
  type BookingRulesPolicy,
  type BusinessHoursPolicy,
} from "@/lib/policy";
import { PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS } from "@/lib/public-quote-mutation";
import {
  QuoteDocumentSnapshotSchema,
  type PublicQuoteAvailability,
} from "@/lib/quote-v2-contract";
import { quoteV2CompletedDepositMatches } from "@/lib/quote-v2-deposit-evidence";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";
import {
  quoteV2PublicAllowedActions,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import {
  loadQuoteV2CapabilityByHash,
  recordQuoteV2CapabilityUse,
  type QuoteV2ResolvedCapability,
} from "@/lib/quote-v2-public-service";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const MINIMUM_LEAD_MINUTES = 120;
const SLOT_INTERVAL_MINUTES = 60;
const HOLD_MINUTES = 15;
const DEFAULT_BUFFER_MINUTES = 30;
const MAX_BOOKING_WINDOW_DAYS = 60;
const CAPACITY_POOL_KEY = "field_service";
const NON_BLOCKING_APPOINTMENT_STATUSES = [
  "canceled",
  "completed",
  "no_show",
] as const;

type QuoteSchedulingDb = DatabaseClient | TeamMutationTransaction;

export type QuoteV2SchedulingSlot =
  PublicQuoteAvailability["recommendedSlots"][number];

export type QuoteV2SchedulingDay = PublicQuoteAvailability["days"][number];

export type QuoteV2Availability = PublicQuoteAvailability;

export type QuoteV2HoldReceipt = {
  quoteId: string;
  versionId: string;
  responseId: string | null;
  holdId: string;
  startAt: string;
  expiresAt: string;
  replacedHoldId: string | null;
  replayed: boolean;
};

export type QuoteV2BookingReceipt = {
  quoteId: string;
  versionId: string;
  responseId: string;
  appointmentId: string;
  holdId: string;
  paymentId: string | null;
  outboxEventId: string;
  startAt: string;
  status: string;
  replayed: boolean;
};

export type QuoteV2OccupancyBlock = {
  id: string;
  startAt: Date;
  endAt: Date;
  capacityUnits: number;
  countsTowardDailyJobs?: boolean;
};

type QuoteV2ScheduleContext = {
  businessHours: BusinessHoursPolicy;
  bookingRules: BookingRulesPolicy;
  timezone: string;
  durationMinutes: number;
  travelBufferMinutes: number;
  bookingWindowDays: number;
  capacity: number;
};

type AcceptedResponse = {
  id: string;
  quoteId: string;
  versionId: string;
  appointmentId: string | null;
  configurationHash: string;
  contentHash: string;
  acceptedTotalMinCents: number;
  acceptedTotalMaxCents: number;
  acceptedDepositCents: number;
  acceptedBalanceMinCents: number;
  acceptedBalanceMaxCents: number;
};

type QuoteSchedulingSubject = {
  quoteId: string;
  propertyId: string;
  contactId: string;
  opportunityId: string;
  acceptedAppointmentId: string | null;
  aggregateRevision: number;
  opportunityRevision: number;
  leadId: string | null;
  ownerTeamMemberId: string | null;
};

type CompletedDeposit = {
  paymentId: string;
  paymentAttemptId: string;
};

function overlaps(
  firstStart: Date,
  firstEnd: Date,
  secondStart: Date,
  secondEnd: Date,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

/** Returns peak occupied capacity, not the number of sequential overlaps. */
export function quoteV2PeakOccupiedCapacity(input: {
  blocks: readonly QuoteV2OccupancyBlock[];
  startAt: Date;
  endAt: Date;
}): number {
  const candidateTimes = [
    input.startAt.getTime(),
    ...input.blocks
      .filter((block) =>
        overlaps(input.startAt, input.endAt, block.startAt, block.endAt),
      )
      .map((block) =>
        Math.max(input.startAt.getTime(), block.startAt.getTime()),
      ),
  ];
  let peak = 0;
  for (const time of new Set(candidateTimes)) {
    if (time >= input.endAt.getTime()) continue;
    const occupied = input.blocks.reduce((sum, block) => {
      return block.startAt.getTime() <= time && time < block.endAt.getTime()
        ? sum + block.capacityUnits
        : sum;
    }, 0);
    peak = Math.max(peak, occupied);
  }
  return peak;
}

export { quoteV2CompletedDepositMatches } from "@/lib/quote-v2-deposit-evidence";

function localDayKey(value: Date, timezone: string): string {
  return (
    DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toISODate() ??
    ""
  );
}

function slotLabel(value: Date, timezone: string): string {
  return DateTime.fromJSDate(value, { zone: "utc" })
    .setZone(timezone)
    .toFormat("ccc, LLL d · h:mm a");
}

function parseDocument(row: QuoteV2ResolvedCapability) {
  const parsed = QuoteDocumentSnapshotSchema.safeParse(row.documentSnapshot);
  if (!parsed.success) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Scheduling details for this proposal are temporarily unavailable.",
    );
  }
  return parsed.data;
}

function configuredCalendarStaleMinutes(): number {
  const parsed = Number(process.env["QUOTE_V2_CALENDAR_STALE_MINUTES"] ?? "15");
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_440
    ? parsed
    : 15;
}

export function quoteV2CalendarCoverageIsCurrent(input: {
  now: Date;
  staleMinutes: number;
  lastSyncedAt: Date | null;
  externalBusyCoverageSyncedAt: Date | null;
  lastNotificationAt: Date | null;
}): boolean {
  if (
    !Number.isSafeInteger(input.staleMinutes) ||
    input.staleMinutes < 1 ||
    input.staleMinutes > 1_440
  ) {
    return false;
  }
  const earliestCurrent = input.now.getTime() - input.staleMinutes * 60_000;
  const maximumFutureSkew = input.now.getTime() + 5 * 60_000;
  return (
    input.lastSyncedAt instanceof Date &&
    input.externalBusyCoverageSyncedAt instanceof Date &&
    input.lastSyncedAt.getTime() >= earliestCurrent &&
    input.externalBusyCoverageSyncedAt.getTime() >= earliestCurrent &&
    input.lastSyncedAt.getTime() <= maximumFutureSkew &&
    input.externalBusyCoverageSyncedAt.getTime() <= maximumFutureSkew &&
    (!(input.lastNotificationAt instanceof Date) ||
      input.lastNotificationAt <= input.lastSyncedAt)
  );
}

async function assertAvailabilityProviderReady(
  db: QuoteSchedulingDb,
  now: Date,
): Promise<void> {
  if (!isGoogleCalendarEnabled()) return;
  const config = getCalendarConfig();
  if (!config) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Appointment availability is temporarily unavailable.",
    );
  }
  const [state] = await db
    .select({
      lastSyncedAt: calendarSyncState.lastSyncedAt,
      lastNotificationAt: calendarSyncState.lastNotificationAt,
      externalBusyCoverageSyncedAt:
        calendarSyncState.externalBusyCoverageSyncedAt,
    })
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarId, config.calendarId))
    .limit(1);
  if (
    !quoteV2CalendarCoverageIsCurrent({
      now,
      staleMinutes: configuredCalendarStaleMinutes(),
      lastSyncedAt: state?.lastSyncedAt ?? null,
      externalBusyCoverageSyncedAt: state?.externalBusyCoverageSyncedAt ?? null,
      lastNotificationAt: state?.lastNotificationAt ?? null,
    })
  ) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Appointment availability is temporarily unavailable.",
    );
  }
}

function assertBoundCapability(
  row: QuoteV2ResolvedCapability,
  input: { quoteId: string; versionId: string },
): void {
  if (row.quoteId !== input.quoteId || row.versionId !== input.versionId) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The scheduling request does not match the displayed proposal.",
    );
  }
}

function assertSchedulingAccess(
  row: QuoteV2ResolvedCapability,
  now: Date,
): void {
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
  if (row.recipientRole !== "signer") {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This recipient has view-only proposal access.",
    );
  }
}

export type QuoteV2SelfServiceContactPolicy = {
  allowCustomerScheduling: boolean;
  allowOutboundConfirmation: boolean;
  revokeCapabilities: boolean;
};

/**
 * A deleted CRM subject invalidates bearer access. DNC governs outbound
 * contact only: it does not turn a customer-initiated scheduling action into
 * an error, but the workflow must not send the confirmation automatically.
 */
export function quoteV2SelfServiceContactPolicy(input: {
  deletedAt: Date | null;
  doNotContact: boolean;
}): QuoteV2SelfServiceContactPolicy {
  if (input.deletedAt) {
    return {
      allowCustomerScheduling: false,
      allowOutboundConfirmation: false,
      revokeCapabilities: true,
    };
  }
  return {
    allowCustomerScheduling: true,
    allowOutboundConfirmation: !input.doNotContact,
    revokeCapabilities: false,
  };
}

function enforceQuoteV2SchedulingContactPolicy(
  row: QuoteV2ResolvedCapability,
): void {
  const policy = quoteV2SelfServiceContactPolicy({
    deletedAt: row.contactDeletedAt,
    doNotContact: row.contactDoNotContact,
  });
  if (policy.allowCustomerScheduling) return;
  throw new QuoteV2PublicStateError(
    "gone",
    "This proposal link is no longer available.",
  );
}

function assertSchedulingAction(
  row: QuoteV2ResolvedCapability,
  action: "availability" | "hold" | "book",
  now: Date,
): void {
  assertSchedulingAccess(row, now);
  if (!quoteV2PublicAllowedActions(row, now).includes(action)) {
    const message = row.acceptedAppointmentId
      ? "This accepted proposal already has an appointment."
      : row.hasOpenChangeRequest
        ? "Scheduling is paused while a change request is open."
        : "This proposal is not currently eligible for that scheduling action.";
    throw new QuoteV2PublicStateError("conflict", message);
  }
}

async function scheduleContext(
  db: QuoteSchedulingDb,
  row: QuoteV2ResolvedCapability,
): Promise<QuoteV2ScheduleContext> {
  const document = parseDocument(row);
  const [businessHours, bookingRules] = await Promise.all([
    getBusinessHoursPolicy(db),
    getBookingRulesPolicy(db),
  ]);
  const timezone = businessHours.timezone?.trim();
  if (!timezone || !DateTime.now().setZone(timezone).isValid) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Appointment availability is temporarily unavailable.",
    );
  }
  const buffer = Number.isFinite(bookingRules.bufferMinutes)
    ? Math.max(0, Math.min(8 * 60, Math.trunc(bookingRules.bufferMinutes)))
    : DEFAULT_BUFFER_MINUTES;
  const policyWindow = Number.isFinite(bookingRules.bookingWindowDays)
    ? Math.trunc(bookingRules.bookingWindowDays)
    : 14;
  return {
    businessHours,
    bookingRules,
    timezone,
    durationMinutes: document.estimatedDurationMinutes,
    travelBufferMinutes: buffer,
    bookingWindowDays: Math.max(
      1,
      Math.min(MAX_BOOKING_WINDOW_DAYS, policyWindow || 14),
    ),
    capacity: getAppointmentCapacity(),
  };
}

async function loadOccupancy(
  db: QuoteSchedulingDb,
  input: {
    startAt: Date;
    endAt: Date;
    now: Date;
    excludeQuoteVersionId?: string;
  },
): Promise<QuoteV2OccupancyBlock[]> {
  const [appointmentRows, holdRows, scheduleBlockRows] = await Promise.all([
    db
      .select({
        id: appointments.id,
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
        capacityUnits: appointments.capacityUnits,
      })
      .from(appointments)
      .where(
        and(
          isNotNull(appointments.startAt),
          eq(appointments.capacityPoolKey, CAPACITY_POOL_KEY),
          notInArray(appointments.status, [
            ...NON_BLOCKING_APPOINTMENT_STATUSES,
          ]),
          lt(appointments.startAt, input.endAt),
          sql`${appointments.startAt} + ((${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute') > ${input.startAt}`,
        ),
      ),
    db
      .select({
        id: appointmentHolds.id,
        startAt: appointmentHolds.startAt,
        durationMinutes: appointmentHolds.durationMinutes,
        travelBufferMinutes: appointmentHolds.travelBufferMinutes,
        capacityUnits: appointmentHolds.capacityUnits,
      })
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.status, "active"),
          eq(appointmentHolds.capacityPoolKey, CAPACITY_POOL_KEY),
          gt(appointmentHolds.expiresAt, input.now),
          lt(appointmentHolds.startAt, input.endAt),
          sql`${appointmentHolds.startAt} + ((${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute') > ${input.startAt}`,
          input.excludeQuoteVersionId
            ? or(
                isNull(appointmentHolds.quoteVersionId),
                ne(
                  appointmentHolds.quoteVersionId,
                  input.excludeQuoteVersionId,
                ),
              )
            : undefined,
        ),
      ),
    db
      .select({
        id: scheduleBlocks.id,
        startAt: scheduleBlocks.startAt,
        endAt: scheduleBlocks.endAt,
        capacityUnits: scheduleBlocks.capacityUnits,
        mirroredAppointmentId: scheduleBlocks.mirroredAppointmentId,
      })
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.capacityPoolKey, CAPACITY_POOL_KEY),
          eq(scheduleBlocks.active, true),
          lt(scheduleBlocks.startAt, input.endAt),
          gt(scheduleBlocks.endAt, input.startAt),
        ),
      ),
  ]);
  const activeAppointmentIds = new Set(appointmentRows.map((row) => row.id));
  return [
    ...appointmentRows.flatMap((row) => {
      if (!(row.startAt instanceof Date)) return [];
      return [
        {
          id: `appointment:${row.id}`,
          startAt: row.startAt,
          endAt: new Date(
            row.startAt.getTime() +
              (row.durationMinutes + row.travelBufferMinutes) * 60_000,
          ),
          capacityUnits: Math.max(1, row.capacityUnits),
          countsTowardDailyJobs: true,
        },
      ];
    }),
    ...holdRows.map((row) => ({
      id: `hold:${row.id}`,
      startAt: row.startAt,
      endAt: new Date(
        row.startAt.getTime() +
          (row.durationMinutes + row.travelBufferMinutes) * 60_000,
      ),
      capacityUnits: Math.max(1, row.capacityUnits),
      countsTowardDailyJobs: true,
    })),
    ...scheduleBlockRows.flatMap((row) => {
      if (
        row.mirroredAppointmentId &&
        activeAppointmentIds.has(row.mirroredAppointmentId)
      ) {
        return [];
      }
      return [
        {
          id: `schedule-block:${row.id}`,
          startAt: row.startAt,
          endAt: row.endAt,
          capacityUnits: Math.max(1, row.capacityUnits),
          countsTowardDailyJobs: false,
        },
      ];
    }),
  ];
}

function dayOccupancyCount(
  blocks: readonly QuoteV2OccupancyBlock[],
  date: string,
  timezone: string,
): number {
  return blocks.filter(
    (block) =>
      block.countsTowardDailyJobs !== false &&
      localDayKey(block.startAt, timezone) === date,
  ).length;
}

function slotHasCapacity(input: {
  blocks: readonly QuoteV2OccupancyBlock[];
  startAt: Date;
  durationMinutes: number;
  travelBufferMinutes: number;
  capacity: number;
}): boolean {
  const endAt = new Date(
    input.startAt.getTime() +
      (input.durationMinutes + input.travelBufferMinutes) * 60_000,
  );
  return (
    quoteV2PeakOccupiedCapacity({
      blocks: input.blocks,
      startAt: input.startAt,
      endAt,
    }) +
      1 <=
    input.capacity
  );
}

async function loadAcceptedResponse(
  db: QuoteSchedulingDb,
  input: {
    quoteId: string;
    versionId: string;
    responseId?: string | null;
    lock?: boolean;
  },
): Promise<AcceptedResponse | null> {
  const query = db
    .select({
      id: quoteResponses.id,
      quoteId: quoteResponses.quoteId,
      versionId: quoteResponses.quoteVersionId,
      appointmentId: quoteResponses.appointmentId,
      configurationHash: quoteResponses.configurationHash,
      contentHash: quoteResponses.contentHash,
      acceptedTotalMinCents: quoteResponses.acceptedTotalMinCents,
      acceptedTotalMaxCents: quoteResponses.acceptedTotalMaxCents,
      acceptedDepositCents: quoteResponses.acceptedDepositCents,
      acceptedBalanceMinCents: quoteResponses.acceptedBalanceMinCents,
      acceptedBalanceMaxCents: quoteResponses.acceptedBalanceMaxCents,
    })
    .from(quoteResponses)
    .where(
      and(
        eq(quoteResponses.quoteId, input.quoteId),
        eq(quoteResponses.quoteVersionId, input.versionId),
        eq(quoteResponses.responseType, "accepted"),
        input.responseId ? eq(quoteResponses.id, input.responseId) : undefined,
      ),
    )
    .limit(1);
  const rows = input.lock ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) return null;
  if (
    !row.configurationHash ||
    !row.contentHash ||
    row.acceptedTotalMinCents === null ||
    row.acceptedTotalMaxCents === null ||
    row.acceptedDepositCents === null ||
    row.acceptedBalanceMinCents === null ||
    row.acceptedBalanceMaxCents === null
  ) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The acceptance evidence required for scheduling is unavailable.",
    );
  }
  return {
    ...row,
    configurationHash: row.configurationHash,
    contentHash: row.contentHash,
    acceptedTotalMinCents: row.acceptedTotalMinCents,
    acceptedTotalMaxCents: row.acceptedTotalMaxCents,
    acceptedDepositCents: row.acceptedDepositCents,
    acceptedBalanceMinCents: row.acceptedBalanceMinCents,
    acceptedBalanceMaxCents: row.acceptedBalanceMaxCents,
  };
}

async function loadSubjectForBooking(
  tx: TeamMutationTransaction,
  row: QuoteV2ResolvedCapability,
): Promise<QuoteSchedulingSubject> {
  const [quote] = await tx
    .select({
      id: quotes.id,
      contactId: quotes.contactId,
      propertyId: quotes.propertyId,
      opportunityId: quotes.salesOpportunityId,
      publishedVersionId: quotes.publishedVersionId,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
    })
    .from(quotes)
    .where(eq(quotes.id, row.quoteId))
    .for("update")
    .limit(1);
  if (
    !quote ||
    !quote.opportunityId ||
    quote.publishedVersionId !== row.versionId ||
    quote.aggregateState !== "accepted" ||
    !quote.aggregateRevision
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The accepted proposal changed before scheduling was completed.",
    );
  }
  const [opportunity] = await tx
    .select({
      id: salesOpportunities.id,
      status: salesOpportunities.status,
      revision: salesOpportunities.revision,
      leadId: salesOpportunities.leadId,
      ownerTeamMemberId: salesOpportunities.ownerTeamMemberId,
    })
    .from(salesOpportunities)
    .where(eq(salesOpportunities.id, quote.opportunityId))
    .for("update")
    .limit(1);
  if (!opportunity || opportunity.status !== "approved") {
    throw new QuoteV2PublicStateError(
      "conflict",
      opportunity?.status === "won"
        ? "This accepted project is already booked."
        : "This project is not ready to be booked.",
    );
  }
  return {
    quoteId: quote.id,
    propertyId: quote.propertyId,
    contactId: quote.contactId,
    opportunityId: opportunity.id,
    acceptedAppointmentId: quote.acceptedAppointmentId,
    aggregateRevision: quote.aggregateRevision,
    opportunityRevision: opportunity.revision,
    leadId: opportunity.leadId,
    ownerTeamMemberId: opportunity.ownerTeamMemberId,
  };
}

function receiptPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readReceipt<T extends Record<string, unknown>>(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    action: "hold" | "book";
    keyHash: string;
    requestHash: string;
    now: Date;
    validate: (value: Record<string, unknown>) => value is T;
  },
): Promise<T | null> {
  const [receipt] = await tx
    .select({
      requestHash: publicQuoteMutationReceipts.requestHash,
      responseBody: publicQuoteMutationReceipts.responseBody,
      expiresAt: publicQuoteMutationReceipts.expiresAt,
    })
    .from(publicQuoteMutationReceipts)
    .where(
      and(
        eq(publicQuoteMutationReceipts.quoteId, input.quoteId),
        eq(publicQuoteMutationReceipts.action, input.action),
        eq(publicQuoteMutationReceipts.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  if (
    receipt.requestHash !== input.requestHash ||
    receipt.expiresAt <= input.now
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This request key was already used for different scheduling details.",
    );
  }
  const body = receiptPayload(receipt.responseBody);
  if (!body || !input.validate(body)) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "The original scheduling receipt cannot be verified.",
    );
  }
  return body;
}

async function writeReceipt(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    action: "hold" | "book";
    keyHash: string;
    requestHash: string;
    responseBody: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(publicQuoteMutationReceipts).values({
    quoteId: input.quoteId,
    action: input.action,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    responseStatus: 201,
    responseBody: input.responseBody,
    createdAt: input.now,
    expiresAt: new Date(
      input.now.getTime() + PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
    ),
  });
}

function isHoldReceipt(
  value: Record<string, unknown>,
): value is QuoteV2HoldReceipt {
  return (
    typeof value["quoteId"] === "string" &&
    typeof value["versionId"] === "string" &&
    (value["responseId"] === null || typeof value["responseId"] === "string") &&
    typeof value["holdId"] === "string" &&
    typeof value["startAt"] === "string" &&
    typeof value["expiresAt"] === "string"
  );
}

function isBookingReceipt(
  value: Record<string, unknown>,
): value is QuoteV2BookingReceipt {
  return (
    typeof value["quoteId"] === "string" &&
    typeof value["versionId"] === "string" &&
    typeof value["responseId"] === "string" &&
    typeof value["appointmentId"] === "string" &&
    typeof value["holdId"] === "string" &&
    typeof value["outboxEventId"] === "string" &&
    typeof value["startAt"] === "string" &&
    typeof value["status"] === "string"
  );
}

function parseLateCapture(metadata: unknown): boolean {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>)["lateCapture"] === true,
  );
}

async function loadExactCompletedDeposit(
  tx: TeamMutationTransaction,
  input: { response: AcceptedResponse },
): Promise<CompletedDeposit | null> {
  if (input.response.acceptedDepositCents === 0) return null;
  const [payment] = await tx
    .select({
      id: payments.id,
      paymentAttemptId: payments.paymentAttemptId,
      provider: payments.provider,
      currency: payments.currency,
      canonicalStatus: payments.canonicalStatus,
      amountCents: payments.amount,
      jobAmountCents: payments.jobAmountCents,
      totalAmountCents: payments.totalAmountCents,
      tipCents: payments.tipCents,
      refundedAmountCents: payments.refundedAmountCents,
      metadata: payments.metadata,
    })
    .from(payments)
    .where(
      and(
        eq(payments.quoteId, input.response.quoteId),
        eq(payments.quoteVersionId, input.response.versionId),
        eq(payments.quoteResponseId, input.response.id),
        eq(payments.quotePaymentKind, "deposit"),
        eq(payments.canonicalStatus, "completed"),
      ),
    )
    .for("update")
    .limit(1);
  if (!payment?.paymentAttemptId) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The required deposit has not been verified yet.",
    );
  }
  const [attempt] = await tx
    .select({
      id: paymentAttempts.id,
      quoteId: paymentAttempts.quoteId,
      versionId: paymentAttempts.quoteVersionId,
      responseId: paymentAttempts.quoteResponseId,
      status: paymentAttempts.status,
      expectedCents: paymentAttempts.requestedJobAmountCents,
      currency: paymentAttempts.currency,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, payment.paymentAttemptId))
    .for("update")
    .limit(1);
  if (
    !attempt ||
    attempt.quoteId !== input.response.quoteId ||
    attempt.versionId !== input.response.versionId ||
    attempt.responseId !== input.response.id ||
    attempt.expectedCents !== input.response.acceptedDepositCents ||
    attempt.currency !== "USD" ||
    !quoteV2CompletedDepositMatches({
      expectedCents: input.response.acceptedDepositCents,
      provider: payment.provider,
      currency: payment.currency,
      canonicalStatus: payment.canonicalStatus,
      amountCents: payment.amountCents,
      jobAmountCents: payment.jobAmountCents,
      totalAmountCents: payment.totalAmountCents,
      tipCents: payment.tipCents,
      refundedAmountCents: payment.refundedAmountCents,
      attemptStatus: attempt.status,
      lateCapture: parseLateCapture(payment.metadata),
    })
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      parseLateCapture(payment.metadata)
        ? "The deposit was received after the prior hold expired. Stonegate must confirm the new appointment time."
        : "The verified deposit does not match this accepted proposal.",
    );
  }
  return { paymentId: payment.id, paymentAttemptId: attempt.id };
}

async function insertPublicAudit(
  tx: TeamMutationTransaction,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    quoteId: string;
    versionId: string;
    responseId: string | null;
    keyHash: string;
    correlationId: string;
    metadata: Record<string, unknown>;
    now: Date;
  },
): Promise<string> {
  const auditEventId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: "system",
    actorLabel: "quote-v2-public-capability",
    correlationId: input.correlationId,
    idempotencyKeyHash: input.keyHash,
    outcome: "succeeded",
    surface: "/api/public/quotes/[capability]/scheduling",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata({
      quoteId: input.quoteId,
      versionId: input.versionId,
      responseId: input.responseId,
      capabilityTokenStored: false,
      ...input.metadata,
    }),
    createdAt: input.now,
  });
  return auditEventId;
}

export async function getQuoteV2Availability(input: {
  tokenHash: string;
  quoteId: string;
  versionId: string;
  responseId?: string | null;
  now?: Date;
}): Promise<QuoteV2Availability> {
  const db = getDb();
  const now = input.now ?? new Date();
  const row = await loadQuoteV2CapabilityByHash(db, {
    tokenHash: input.tokenHash,
  });
  if (!row) {
    throw new QuoteV2PublicStateError(
      "gone",
      "This proposal link is no longer available.",
    );
  }
  assertBoundCapability(row, input);
  enforceQuoteV2SchedulingContactPolicy(row);
  assertSchedulingAction(row, "availability", now);
  await assertAvailabilityProviderReady(db, now);
  const response = await loadAcceptedResponse(db, input);
  if (input.responseId && !response) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The accepted response does not match this proposal.",
    );
  }
  const context = await scheduleContext(db, row);
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(
    context.timezone,
  );
  const rangeStart = now;
  const rangeEnd = nowLocal
    .plus({ days: context.bookingWindowDays + 1 })
    .endOf("day")
    .toUTC()
    .toJSDate();
  const blocks = await loadOccupancy(db, {
    startAt: rangeStart,
    endAt: rangeEnd,
    now,
  });
  const days: QuoteV2SchedulingDay[] = [];
  const recommendedSlots: QuoteV2SchedulingSlot[] = [];
  for (let day = 0; day < context.bookingWindowDays; day += 1) {
    const localDay = nowLocal.plus({ days: day }).startOf("day");
    const date = localDay.toISODate();
    if (!date) continue;
    const slots: QuoteV2SchedulingSlot[] = [];
    const maxReached =
      context.bookingRules.maxJobsPerDay > 0 &&
      dayOccupancyCount(blocks, date, context.timezone) >=
        context.bookingRules.maxJobsPerDay;
    if (!maxReached) {
      for (const window of getBusinessHourWindowsForDate(
        localDay,
        context.businessHours,
      )) {
        let cursor = window.start;
        while (
          cursor.plus({ minutes: context.durationMinutes }) <= window.end
        ) {
          if (cursor > nowLocal.plus({ minutes: MINIMUM_LEAD_MINUTES })) {
            const startAt = cursor.toUTC().toJSDate();
            if (
              slotHasCapacity({
                blocks,
                startAt,
                durationMinutes: context.durationMinutes,
                travelBufferMinutes: context.travelBufferMinutes,
                capacity: context.capacity,
              })
            ) {
              const slot = {
                startAt: startAt.toISOString(),
                endAt: new Date(
                  startAt.getTime() + context.durationMinutes * 60_000,
                ).toISOString(),
                label: slotLabel(startAt, context.timezone),
              };
              slots.push(slot);
              if (recommendedSlots.length < 3) recommendedSlots.push(slot);
            }
          }
          cursor = cursor.plus({ minutes: SLOT_INTERVAL_MINUTES });
        }
      }
    }
    days.push({ date, slots });
  }
  await recordQuoteV2CapabilityUse(db, {
    capabilityId: row.capabilityId,
    at: now,
  });
  return {
    state: recommendedSlots.length > 0 ? "available" : "empty",
    quoteId: row.quoteId,
    versionId: row.versionId,
    responseId: response?.id ?? null,
    timezone: context.timezone,
    durationMinutes: context.durationMinutes,
    travelBufferMinutes: context.travelBufferMinutes,
    arrivalWindowMeaning:
      "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
    recommendedSlots,
    days,
    generatedAt: now.toISOString(),
  };
}

function validateRequestedSlot(input: {
  startAtIso: string;
  timezone: string;
  context: QuoteV2ScheduleContext;
  blocks: readonly QuoteV2OccupancyBlock[];
  now: Date;
}): Date {
  if (input.timezone !== input.context.timezone) {
    throw new QuoteV2PublicStateError(
      "invalid",
      "Refresh availability before selecting a time in another timezone.",
      { timezone: `Use ${input.context.timezone}.` },
    );
  }
  const parsed = DateTime.fromISO(input.startAtIso, { setZone: true });
  if (!parsed.isValid) {
    throw new QuoteV2PublicStateError(
      "invalid",
      "Choose a valid appointment time.",
      { startAt: "Choose a time from current availability." },
    );
  }
  const startAt = parsed.toUTC().toJSDate();
  const nowLocal = DateTime.fromJSDate(input.now, { zone: "utc" }).setZone(
    input.context.timezone,
  );
  const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(
    input.context.timezone,
  );
  if (
    startLocal <= nowLocal.plus({ minutes: MINIMUM_LEAD_MINUTES }) ||
    startLocal >
      nowLocal.plus({ days: input.context.bookingWindowDays }).endOf("day")
  ) {
    throw new QuoteV2PublicStateError(
      "invalid",
      "Choose a time from the current appointment window.",
      { startAt: "Refresh availability and select a current time." },
    );
  }
  if (
    !isWithinBusinessHours(
      startAt,
      input.context.durationMinutes,
      input.context.businessHours,
    )
  ) {
    throw new QuoteV2PublicStateError(
      "invalid",
      "That time is outside current business hours.",
      { startAt: "Choose a listed appointment time." },
    );
  }
  const date = localDayKey(startAt, input.context.timezone);
  if (
    input.context.bookingRules.maxJobsPerDay > 0 &&
    dayOccupancyCount(input.blocks, date, input.context.timezone) >=
      input.context.bookingRules.maxJobsPerDay
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "That date no longer has appointment capacity.",
    );
  }
  if (
    !slotHasCapacity({
      blocks: input.blocks,
      startAt,
      durationMinutes: input.context.durationMinutes,
      travelBufferMinutes: input.context.travelBufferMinutes,
      capacity: input.context.capacity,
    })
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "That appointment time is no longer available.",
    );
  }
  return startAt;
}

export async function createQuoteV2AppointmentHold(input: {
  tokenHash: string;
  quoteId: string;
  versionId: string;
  responseId?: string | null;
  startAt: string;
  timezone: string;
  idempotencyKeyHash: string;
  requestHash: string;
  correlationId: string;
  now?: Date;
}): Promise<QuoteV2HoldReceipt> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertBoundCapability(row, input);
    enforceQuoteV2SchedulingContactPolicy(row);
    assertSchedulingAccess(row, now);
    const replay = await readReceipt(tx, {
      quoteId: row.quoteId,
      action: "hold",
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      now,
      validate: isHoldReceipt,
    });
    if (replay) return { ...replay, replayed: true };
    assertSchedulingAction(row, "hold", now);
    await assertAvailabilityProviderReady(tx, now);
    const accepted =
      row.aggregateState === "accepted" && row.versionState === "accepted";
    const response = accepted
      ? await loadAcceptedResponse(tx, {
          ...input,
          lock: true,
        })
      : null;
    if (accepted && (!response || response.contentHash !== row.contentHash)) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The acceptance evidence does not match this proposal.",
      );
    }
    if (!accepted && input.responseId) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This proposal has not recorded that acceptance response.",
      );
    }
    if (row.acceptedAppointmentId || response?.appointmentId) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This accepted proposal already has an appointment.",
      );
    }
    const [quote] = await tx
      .select({
        contactId: quotes.contactId,
        propertyId: quotes.propertyId,
        acceptedAppointmentId: quotes.acceptedAppointmentId,
      })
      .from(quotes)
      .where(
        and(
          eq(quotes.id, row.quoteId),
          eq(quotes.publishedVersionId, row.versionId),
          accepted
            ? eq(quotes.aggregateState, "accepted")
            : eq(quotes.aggregateState, "open"),
        ),
      )
      .for("update")
      .limit(1);
    if (!quote || quote.acceptedAppointmentId) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This accepted proposal is no longer available for scheduling.",
      );
    }
    const context = await scheduleContext(tx, row);
    const localStart = DateTime.fromISO(input.startAt, { setZone: true });
    const candidateStart = localStart.isValid
      ? localStart.toUTC().toJSDate()
      : now;
    const rangeStart = DateTime.fromJSDate(candidateStart, { zone: "utc" })
      .setZone(context.timezone)
      .startOf("day")
      .toUTC()
      .toJSDate();
    const rangeEnd = DateTime.fromJSDate(candidateStart, { zone: "utc" })
      .setZone(context.timezone)
      .endOf("day")
      .toUTC()
      .toJSDate();
    const blocks = await loadOccupancy(tx, {
      startAt: rangeStart,
      endAt: rangeEnd,
      now,
      excludeQuoteVersionId: row.versionId,
    });
    const startAt = validateRequestedSlot({
      startAtIso: input.startAt,
      timezone: input.timezone,
      context,
      blocks,
      now,
    });
    const [existingHold] = await tx
      .select({
        id: appointmentHolds.id,
        expiresAt: appointmentHolds.expiresAt,
      })
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.quoteVersionId, row.versionId),
          eq(appointmentHolds.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (existingHold) {
      await tx
        .update(appointmentHolds)
        .set({
          status: existingHold.expiresAt > now ? "replaced" : "expired",
          updatedAt: now,
        })
        .where(
          and(
            eq(appointmentHolds.id, existingHold.id),
            eq(appointmentHolds.status, "active"),
          ),
        );
    }
    const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
    const [hold] = await tx
      .insert(appointmentHolds)
      .values({
        fullQuoteId: row.quoteId,
        quoteVersionId: row.versionId,
        contactId: quote.contactId,
        propertyId: quote.propertyId,
        startAt,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        capacityPoolKey: "field_service",
        capacityUnits: 1,
        idempotencyKeyHash: input.idempotencyKeyHash,
        status: "active",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: appointmentHolds.id });
    if (!hold) {
      throw new QuoteV2PublicStateError(
        "provider_unavailable",
        "The appointment time could not be held.",
      );
    }
    await tx.insert(quoteActivityEvents).values({
      quoteId: row.quoteId,
      quoteVersionId: row.versionId,
      eventType: existingHold
        ? "appointment_hold_replaced"
        : "appointment_held",
      actorType: "customer",
      correlationId: input.correlationId,
      metadata: {
        responseId: response?.id ?? null,
        holdId: hold.id,
        replacedHoldId: existingHold?.id ?? null,
        startAt: startAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      occurredAt: now,
      createdAt: now,
    });
    await insertPublicAudit(tx, {
      action: "quote.public_hold.v2",
      entityType: "appointment_hold",
      entityId: hold.id,
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response?.id ?? null,
      keyHash: input.idempotencyKeyHash,
      correlationId: input.correlationId,
      metadata: { holdId: hold.id, replacedHoldId: existingHold?.id ?? null },
      now,
    });
    await recordQuoteV2CapabilityUse(tx, {
      capabilityId: row.capabilityId,
      at: now,
    });
    const receipt: QuoteV2HoldReceipt = {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response?.id ?? null,
      holdId: hold.id,
      startAt: startAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      replacedHoldId: existingHold?.id ?? null,
      replayed: false,
    };
    await writeReceipt(tx, {
      quoteId: row.quoteId,
      action: "hold",
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      responseBody: receipt,
      now,
    });
    return receipt;
  });
}

export async function bookQuoteV2AcceptedResponse(input: {
  tokenHash: string;
  quoteId: string;
  versionId: string;
  responseId: string;
  holdId?: string | null;
  idempotencyKeyHash: string;
  requestHash: string;
  correlationId: string;
  now?: Date;
  /** Allows acceptance and no-deposit booking to share one outer transaction. */
  transaction?: TeamMutationTransaction;
}): Promise<QuoteV2BookingReceipt> {
  const db = getDb();
  const now = input.now ?? new Date();
  const execute = async (
    tx: TeamMutationTransaction,
  ): Promise<QuoteV2BookingReceipt> => {
    await acquireScheduleConflictLock(tx);
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertBoundCapability(row, input);
    enforceQuoteV2SchedulingContactPolicy(row);
    assertSchedulingAccess(row, now);
    const replay = await readReceipt(tx, {
      quoteId: row.quoteId,
      action: "book",
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      now,
      validate: isBookingReceipt,
    });
    if (replay) return { ...replay, replayed: true };
    assertSchedulingAction(row, "book", now);
    await assertAvailabilityProviderReady(tx, now);
    if (!input.holdId) {
      throw new QuoteV2PublicStateError(
        "invalid",
        "Select and hold an appointment time before booking.",
        { holdId: "Select an available appointment time." },
      );
    }
    const response = await loadAcceptedResponse(tx, {
      ...input,
      lock: true,
    });
    if (!response || response.contentHash !== row.contentHash) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The acceptance evidence does not match this proposal.",
      );
    }
    const subject = await loadSubjectForBooking(tx, row);
    if (subject.acceptedAppointmentId || response.appointmentId) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This accepted proposal already has an appointment.",
      );
    }
    const [hold] = await tx
      .select({
        id: appointmentHolds.id,
        quoteId: appointmentHolds.fullQuoteId,
        versionId: appointmentHolds.quoteVersionId,
        contactId: appointmentHolds.contactId,
        propertyId: appointmentHolds.propertyId,
        startAt: appointmentHolds.startAt,
        durationMinutes: appointmentHolds.durationMinutes,
        travelBufferMinutes: appointmentHolds.travelBufferMinutes,
        status: appointmentHolds.status,
        expiresAt: appointmentHolds.expiresAt,
      })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, input.holdId))
      .for("update")
      .limit(1);
    if (
      !hold ||
      hold.quoteId !== row.quoteId ||
      hold.versionId !== row.versionId ||
      hold.contactId !== subject.contactId ||
      hold.propertyId !== subject.propertyId ||
      hold.status !== "active" ||
      hold.expiresAt <= now
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The appointment hold expired or no longer matches this acceptance.",
      );
    }
    const context = await scheduleContext(tx, row);
    if (
      hold.durationMinutes !== context.durationMinutes ||
      hold.travelBufferMinutes !== context.travelBufferMinutes
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "Scheduling policy changed after this hold was created. Choose the time again.",
      );
    }
    const localStart = DateTime.fromJSDate(hold.startAt, {
      zone: "utc",
    }).setZone(context.timezone);
    const blocks = await loadOccupancy(tx, {
      startAt: localStart.startOf("day").toUTC().toJSDate(),
      endAt: localStart.endOf("day").toUTC().toJSDate(),
      now,
      excludeQuoteVersionId: row.versionId,
    });
    if (
      !slotHasCapacity({
        blocks,
        startAt: hold.startAt,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        capacity: context.capacity,
      })
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "That appointment time is no longer available.",
      );
    }
    const deposit = await loadExactCompletedDeposit(tx, { response });
    const document = parseDocument(row);
    const quotedScopeText = document.scope.trim().slice(0, 4_000);
    const status = await resolveAutomaticAppointmentStatusForMedia({
      proposedStatus: "confirmed",
      quotedScopeText,
      contactId: subject.contactId,
      database: tx,
      now,
    });
    const [appointment] = await tx
      .insert(appointments)
      .values({
        quoteVersionId: row.versionId,
        quoteResponseId: response.id,
        salesOpportunityId: subject.opportunityId,
        contactId: subject.contactId,
        propertyId: subject.propertyId,
        leadId: subject.leadId,
        type: "job",
        startAt: hold.startAt,
        schedulingTimezone: context.timezone,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        capacityPoolKey: "field_service",
        capacityUnits: 1,
        status,
        quotedTotalCents: response.acceptedTotalMinCents,
        quotedTotalMaxCents: response.acceptedTotalMaxCents,
        quoteConfigurationHash: response.configurationHash,
        quoteContentHash: response.contentHash,
        quotedScopeText,
        soldByMemberId: subject.ownerTeamMemberId,
        rescheduleToken: randomUUID(),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: appointments.id, status: appointments.status });
    if (!appointment) {
      throw new QuoteV2PublicStateError(
        "provider_unavailable",
        "The appointment could not be created.",
      );
    }
    const [updatedResponse] = await tx
      .update(quoteResponses)
      .set({ appointmentId: appointment.id })
      .where(
        and(
          eq(quoteResponses.id, response.id),
          eq(quoteResponses.quoteId, row.quoteId),
          eq(quoteResponses.quoteVersionId, row.versionId),
          eq(quoteResponses.responseType, "accepted"),
          isNull(quoteResponses.appointmentId),
        ),
      )
      .returning({ id: quoteResponses.id });
    if (!updatedResponse) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This acceptance was already attached to another appointment.",
      );
    }
    const [consumed] = await tx
      .update(appointmentHolds)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(appointmentHolds.id, hold.id),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, now),
        ),
      )
      .returning({ id: appointmentHolds.id });
    if (!consumed) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The appointment hold was consumed by another request.",
      );
    }
    const [updatedQuote] = await tx
      .update(quotes)
      .set({
        acceptedAppointmentId: appointment.id,
        aggregateRevision: subject.aggregateRevision + 1,
        revision: subject.aggregateRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(quotes.id, row.quoteId),
          eq(quotes.publishedVersionId, row.versionId),
          eq(quotes.aggregateState, "accepted"),
          eq(quotes.aggregateRevision, subject.aggregateRevision),
          isNull(quotes.acceptedAppointmentId),
        ),
      )
      .returning({ id: quotes.id });
    if (!updatedQuote) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The proposal changed while the appointment was booked.",
      );
    }
    const [updatedOpportunity] = await tx
      .update(salesOpportunities)
      .set({
        status: "won",
        pipelineStage: "won",
        revision: subject.opportunityRevision + 1,
        closedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(salesOpportunities.id, subject.opportunityId),
          eq(salesOpportunities.status, "approved"),
          eq(salesOpportunities.revision, subject.opportunityRevision),
        ),
      )
      .returning({ id: salesOpportunities.id });
    if (!updatedOpportunity) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The project changed while the appointment was booked.",
      );
    }
    if (deposit) {
      const [attachedPayment] = await tx
        .update(payments)
        .set({ appointmentId: appointment.id, updatedAt: now })
        .where(
          and(
            eq(payments.id, deposit.paymentId),
            isNull(payments.appointmentId),
          ),
        )
        .returning({ id: payments.id });
      const [attachedAttempt] = await tx
        .update(paymentAttempts)
        .set({ appointmentId: appointment.id, updatedAt: now })
        .where(
          and(
            eq(paymentAttempts.id, deposit.paymentAttemptId),
            isNull(paymentAttempts.appointmentId),
          ),
        )
        .returning({ id: paymentAttempts.id });
      if (!attachedPayment || !attachedAttempt) {
        throw new QuoteV2PublicStateError(
          "conflict",
          "The verified deposit was already allocated to another booking.",
        );
      }
    }
    const eventId = randomUUID();
    const eventPayload = {
      schemaVersion: 2 as const,
      eventId,
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      appointmentId: appointment.id,
      holdId: hold.id,
      paymentAttemptId: deposit?.paymentAttemptId ?? null,
      paymentId: deposit?.paymentId ?? null,
      correlationId: input.correlationId,
      occurredAt: now.toISOString(),
    };
    parseQuoteV2OutboxEvent({
      type: "quote.accepted_and_booked.v2",
      payload: eventPayload,
    });
    await tx.insert(outboxEvents).values({
      id: eventId,
      type: "quote.accepted_and_booked.v2",
      payload: eventPayload,
      createdAt: now,
    });
    await tx.insert(quoteActivityEvents).values({
      quoteId: row.quoteId,
      quoteVersionId: row.versionId,
      eventType: "accepted_and_booked",
      actorType: "customer",
      outboxEventId: eventId,
      correlationId: input.correlationId,
      metadata: {
        responseId: response.id,
        appointmentId: appointment.id,
        holdId: hold.id,
        paymentId: deposit?.paymentId ?? null,
        acceptedTotalMinCents: response.acceptedTotalMinCents,
        acceptedTotalMaxCents: response.acceptedTotalMaxCents,
      },
      occurredAt: now,
      createdAt: now,
    });
    await insertPublicAudit(tx, {
      action: "quote.public_booked.v2",
      entityType: "appointment",
      entityId: appointment.id,
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      keyHash: input.idempotencyKeyHash,
      correlationId: input.correlationId,
      metadata: {
        appointmentId: appointment.id,
        holdId: hold.id,
        paymentId: deposit?.paymentId ?? null,
        outboxEventId: eventId,
      },
      now,
    });
    await recordQuoteV2CapabilityUse(tx, {
      capabilityId: row.capabilityId,
      at: now,
    });
    const receipt: QuoteV2BookingReceipt = {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      appointmentId: appointment.id,
      holdId: hold.id,
      paymentId: deposit?.paymentId ?? null,
      outboxEventId: eventId,
      startAt: hold.startAt.toISOString(),
      status: appointment.status,
      replayed: false,
    };
    await writeReceipt(tx, {
      quoteId: row.quoteId,
      action: "book",
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      responseBody: receipt,
      now,
    });
    return receipt;
  };
  return input.transaction
    ? execute(input.transaction)
    : db.transaction(execute);
}
