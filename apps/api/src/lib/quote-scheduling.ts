import { DateTime } from "luxon";
import crypto from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  appointmentHolds,
  appointmentNotes,
  appointments,
  contacts,
  crmPipeline,
  getDb,
  leadAutomationStates,
  leads,
  outboxEvents,
  properties,
  publicQuoteMutationReceipts,
  quotes,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  getBookingRulesPolicy,
  getBusinessHourWindowsForDate,
  getBusinessHoursPolicy,
  isWithinBusinessHours,
} from "@/lib/policy";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { resolveAutomaticAppointmentStatusForMedia } from "@/lib/appointment-media";
import {
  isPublicQuoteMutationSuccessBody,
  PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
  publicQuoteMutationKeyHash,
  publicQuoteMutationRequestHash,
} from "@/lib/public-quote-mutation";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { DEFAULT_TRAVEL_BUFFER_MIN } from "../../app/api/web/scheduling";

const QUOTE_BOOKING_WINDOW_DAYS = 14;
const SLOT_INTERVAL_MINUTES = 60;
const HOLD_WINDOW_MINUTES = 15;

export type QuoteSlot = {
  startAt: string;
  endAt: string;
  label: string;
};

export type QuoteDaySlots = {
  date: string;
  slots: QuoteSlot[];
};

export type PublicQuoteSchedulingRow = {
  id: string;
  status: "pending" | "sent" | "accepted" | "declined";
  revision: number;
  quoteNumber: string | null;
  contactId: string;
  propertyId: string;
  services: string[];
  total: unknown;
  jobDurationMinutes: number;
  clientScope: string | null;
  expiresAt: Date | null;
  acceptedAppointmentId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
  propertyAddressLine1: string;
  propertyCity: string;
  propertyState: string;
  propertyPostalCode: string;
};

type Block = {
  start: Date;
  end: Date;
};

type DbExecutor = ReturnType<typeof getDb> | TeamMutationTransaction;

export type PublicQuoteSchedulingErrorCode =
  | "not_found"
  | "invalid"
  | "conflict"
  | "expired"
  | "slot_full"
  | "already_booked"
  | "internal";

export class PublicQuoteSchedulingError extends Error {
  readonly code: PublicQuoteSchedulingErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: PublicQuoteSchedulingErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "PublicQuoteSchedulingError";
    this.code = code;
    this.status =
      options.status ??
      (code === "not_found"
        ? 404
        : code === "expired"
          ? 410
          : code === "invalid"
            ? 422
            : code === "internal"
              ? 500
              : 409);
    this.retryable = options.retryable ?? code === "internal";
  }
}

type PublicQuoteMutationExecution<T extends Record<string, unknown>> = {
  data: T;
  replayed: boolean;
  responseStatus: number;
};

export async function runBestEffortQuoteHoldCleanup(
  cleanup: () => Promise<unknown>,
  context: { quoteId: string; appointmentId: string },
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn("[quote-scheduling] expired_hold_cleanup_failed", {
      quoteId: context.quoteId,
      appointmentId: context.appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function overlapsCount(blocks: Block[], start: Date, end: Date): number {
  let count = 0;
  for (const block of blocks) {
    if (overlaps(start, end, block.start, block.end)) count += 1;
  }
  return count;
}

function localDayKey(value: Date, timezone: string): string {
  return (
    DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toISODate() ??
    ""
  );
}

function formatSlotLabel(startAt: Date, timezone: string): string {
  return DateTime.fromJSDate(startAt, { zone: "utc" })
    .setZone(timezone)
    .toLocaleString(DateTime.TIME_SIMPLE);
}

export function quoteIsExpired(quote: { expiresAt: Date | null }): boolean {
  return quote.expiresAt ? quote.expiresAt.getTime() < Date.now() : false;
}

export async function loadPublicQuoteForScheduling(
  token: string,
): Promise<PublicQuoteSchedulingRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      revision: quotes.revision,
      quoteNumber: quotes.quoteNumber,
      contactId: quotes.contactId,
      propertyId: quotes.propertyId,
      services: quotes.services,
      total: quotes.total,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      expiresAt: quotes.expiresAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.shareToken, token))
    .limit(1);

  if (
    !row?.id ||
    !row.propertyAddressLine1 ||
    !row.propertyCity ||
    !row.propertyState ||
    !row.propertyPostalCode
  ) {
    return null;
  }
  return {
    ...row,
    propertyAddressLine1: row.propertyAddressLine1,
    propertyCity: row.propertyCity,
    propertyState: row.propertyState,
    propertyPostalCode: row.propertyPostalCode,
  };
}

async function loadScheduleBlocks(
  input: {
    start: Date;
    end: Date;
    fallbackDurationMinutes: number;
    fallbackTravelBufferMinutes: number;
  },
  db: DbExecutor = getDb(),
): Promise<Block[]> {
  const [appointmentRows, holdRows] = await Promise.all([
    db
      .select({
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
      })
      .from(appointments)
      .where(
        and(
          gte(appointments.startAt, input.start),
          lte(appointments.startAt, input.end),
          ne(appointments.status, "canceled"),
        ),
      ),
    db
      .select({
        startAt: appointmentHolds.startAt,
        durationMinutes: appointmentHolds.durationMinutes,
        travelBufferMinutes: appointmentHolds.travelBufferMinutes,
      })
      .from(appointmentHolds)
      .where(
        and(
          gte(appointmentHolds.startAt, input.start),
          lte(appointmentHolds.startAt, input.end),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, new Date()),
        ),
      ),
  ]);

  return [...appointmentRows, ...holdRows].flatMap((row) => {
    const start = row.startAt;
    if (!(start instanceof Date)) return [];
    const duration =
      (row.durationMinutes ?? input.fallbackDurationMinutes) +
      (row.travelBufferMinutes ?? input.fallbackTravelBufferMinutes);
    return [{ start, end: new Date(start.getTime() + duration * 60_000) }];
  });
}

async function getQuoteScheduleContext(
  quote: PublicQuoteSchedulingRow,
  db: DbExecutor = getDb(),
) {
  const [businessHours, bookingRules] = await Promise.all([
    getBusinessHoursPolicy(db),
    getBookingRulesPolicy(db),
  ]);
  const timezone =
    businessHours.timezone ||
    process.env["APPOINTMENT_TIMEZONE"] ||
    "America/New_York";
  const durationMinutes = quote.jobDurationMinutes || 120;
  const travelBufferMinutes =
    typeof bookingRules.bufferMinutes === "number" &&
    Number.isFinite(bookingRules.bufferMinutes)
      ? bookingRules.bufferMinutes
      : DEFAULT_TRAVEL_BUFFER_MIN;
  const capacity = getAppointmentCapacity();
  return {
    businessHours,
    bookingRules,
    timezone,
    durationMinutes,
    travelBufferMinutes,
    capacity,
  };
}

export async function getQuoteAvailability(
  quote: PublicQuoteSchedulingRow,
): Promise<{
  days: QuoteDaySlots[];
  suggestions: QuoteSlot[];
  durationMinutes: number;
  travelBufferMinutes: number;
  timezone: string;
}> {
  const context = await getQuoteScheduleContext(quote);
  const nowLocal = DateTime.now().setZone(context.timezone);
  const nowUtc = new Date();
  const lookbackStart = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = nowUtc;
  windowEnd.setUTCDate(windowEnd.getUTCDate() + QUOTE_BOOKING_WINDOW_DAYS + 1);
  const blocks = await loadScheduleBlocks({
    start: lookbackStart,
    end: windowEnd,
    fallbackDurationMinutes: context.durationMinutes,
    fallbackTravelBufferMinutes: context.travelBufferMinutes,
  });

  const dayTotals = new Map<string, number>();
  for (const block of blocks) {
    const key = localDayKey(block.start, context.timezone);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + 1);
  }

  const days: QuoteDaySlots[] = [];
  const suggestions: QuoteSlot[] = [];
  for (let day = 0; day < QUOTE_BOOKING_WINDOW_DAYS; day++) {
    const baseDay = nowLocal.plus({ days: day }).startOf("day");
    const dayKey = baseDay.toISODate();
    if (!dayKey) continue;
    const daySlots: QuoteSlot[] = [];
    const windows = getBusinessHourWindowsForDate(
      baseDay,
      context.businessHours,
    );
    if (
      context.bookingRules.maxJobsPerDay > 0 &&
      (dayTotals.get(dayKey) ?? 0) >= context.bookingRules.maxJobsPerDay
    ) {
      days.push({ date: dayKey, slots: daySlots });
      continue;
    }

    for (const window of windows) {
      let cursor = window.start;
      while (cursor.plus({ minutes: context.durationMinutes }) <= window.end) {
        if (cursor > nowLocal.plus({ hours: 2 })) {
          const start = cursor.toUTC().toJSDate();
          const end = new Date(
            start.getTime() +
              (context.durationMinutes + context.travelBufferMinutes) * 60_000,
          );
          if (overlapsCount(blocks, start, end) < context.capacity) {
            const slot = {
              startAt: start.toISOString(),
              endAt: new Date(
                start.getTime() + context.durationMinutes * 60_000,
              ).toISOString(),
              label: formatSlotLabel(start, context.timezone),
            };
            daySlots.push(slot);
            if (suggestions.length < 6) suggestions.push(slot);
          }
        }
        cursor = cursor.plus({ minutes: SLOT_INTERVAL_MINUTES });
      }
    }
    days.push({ date: dayKey, slots: daySlots });
  }

  return {
    days,
    suggestions,
    durationMinutes: context.durationMinutes,
    travelBufferMinutes: context.travelBufferMinutes,
    timezone: context.timezone,
  };
}

type SchedulingReceiptAction = "hold" | "book";

function isSchedulingReceiptBody(
  action: SchedulingReceiptAction,
  quoteId: string,
  value: unknown,
): value is Record<string, unknown> {
  if (
    !isPublicQuoteMutationSuccessBody(value) ||
    value["quoteId"] !== quoteId ||
    typeof value["auditEventId"] !== "string" ||
    value["auditEventId"].length === 0
  ) {
    return false;
  }
  if (action === "hold") {
    return (
      typeof value["holdId"] === "string" &&
      value["holdId"].length > 0 &&
      typeof value["expiresAt"] === "string" &&
      Number.isFinite(Date.parse(value["expiresAt"])) &&
      typeof value["version"] === "number" &&
      Number.isSafeInteger(value["version"]) &&
      value["version"] > 0
    );
  }
  return (
    typeof value["appointmentId"] === "string" &&
    value["appointmentId"].length > 0 &&
    (value["leadId"] === null || typeof value["leadId"] === "string") &&
    typeof value["startAt"] === "string" &&
    Number.isFinite(Date.parse(value["startAt"])) &&
    typeof value["status"] === "string" &&
    value["quoteStatus"] === "accepted" &&
    typeof value["quoteRevision"] === "number" &&
    Number.isSafeInteger(value["quoteRevision"]) &&
    value["quoteRevision"] > 0 &&
    value["pipelineStage"] === "won"
  );
}

async function readSchedulingReceipt(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    action: SchedulingReceiptAction;
    keyHash: string;
    requestHash: string;
    now: Date;
  },
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  const [receipt] = await tx
    .select({
      requestHash: publicQuoteMutationReceipts.requestHash,
      responseStatus: publicQuoteMutationReceipts.responseStatus,
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
  if (receipt.requestHash !== input.requestHash) {
    throw new PublicQuoteSchedulingError(
      "conflict",
      "This request key was already used for different booking details. Refresh before trying again.",
    );
  }
  if (receipt.expiresAt <= input.now) {
    throw new PublicQuoteSchedulingError(
      "conflict",
      "This request key has expired. Refresh before trying again.",
    );
  }
  if (
    !isSchedulingReceiptBody(input.action, input.quoteId, receipt.responseBody)
  ) {
    throw new PublicQuoteSchedulingError(
      "internal",
      "The original booking receipt is incomplete. Contact Stonegate before retrying.",
      { retryable: false },
    );
  }
  return { body: receipt.responseBody, status: receipt.responseStatus };
}

async function writeSchedulingReceipt(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    action: SchedulingReceiptAction;
    keyHash: string;
    requestHash: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(publicQuoteMutationReceipts).values({
    quoteId: input.quoteId,
    action: input.action,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    responseStatus: input.responseStatus,
    responseBody: input.responseBody,
    createdAt: input.now,
    expiresAt: new Date(
      input.now.getTime() + PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
    ),
  });
}

async function writePublicSchedulingAudit(
  tx: TeamMutationTransaction,
  input: {
    action: "quote.public_hold" | "quote.public_booked";
    quoteId: string;
    correlationId: string;
    keyHash: string;
    before?: Record<string, unknown> | null;
    after: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    now: Date;
  },
): Promise<string> {
  const auditEventId = crypto.randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: "system",
    actorLabel: "public-quote-capability",
    correlationId: input.correlationId,
    outcome: "succeeded",
    surface: "/quote/[token]",
    idempotencyKeyHash: input.keyHash,
    action: input.action,
    entityType: "quote",
    entityId: input.quoteId,
    meta: sanitizeAuditMetadata({
      eventId: auditEventId,
      correlationId: input.correlationId,
      source: "customer",
      capabilityTokenStored: false,
      before: input.before ?? null,
      after: input.after,
      ...(input.metadata ?? {}),
    }),
    createdAt: input.now,
  });
  return auditEventId;
}

function assertCurrentSchedulingQuote(
  current:
    | {
        id: string;
        contactId: string;
        propertyId: string;
        status: "pending" | "sent" | "accepted" | "declined";
        revision: number;
        expiresAt: Date | null;
        acceptedAppointmentId: string | null;
      }
    | undefined,
  input: {
    quote: PublicQuoteSchedulingRow;
    expectedRevision: number;
  },
): asserts current is {
  id: string;
  contactId: string;
  propertyId: string;
  status: "pending" | "sent" | "accepted" | "declined";
  revision: number;
  expiresAt: Date | null;
  acceptedAppointmentId: string | null;
} {
  if (!current || current.id !== input.quote.id) {
    throw new PublicQuoteSchedulingError("not_found", "Quote not found.");
  }
  if (
    current.contactId !== input.quote.contactId ||
    current.propertyId !== input.quote.propertyId
  ) {
    throw new PublicQuoteSchedulingError(
      "conflict",
      "The quote customer or property changed. Refresh before booking.",
    );
  }
  if (current.revision !== input.expectedRevision) {
    throw new PublicQuoteSchedulingError(
      "conflict",
      "The quote changed after this page loaded. Refresh before booking.",
    );
  }
  if (current.expiresAt && current.expiresAt.getTime() < Date.now()) {
    throw new PublicQuoteSchedulingError(
      "expired",
      "This quote has expired. Request a refreshed quote before booking.",
    );
  }
  if (current.status !== "sent" && current.status !== "accepted") {
    throw new PublicQuoteSchedulingError(
      "conflict",
      "This quote is not open for customer booking.",
    );
  }
}

export async function createQuoteAppointmentHold(input: {
  quote: PublicQuoteSchedulingRow;
  capabilityToken: string;
  expectedRevision: number;
  startAtIso: string;
  idempotencyKey: string;
  correlationId: string;
}): Promise<
  PublicQuoteMutationExecution<{
    ok: true;
    quoteId: string;
    holdId: string;
    expiresAt: string;
    version: number;
    auditEventId: string;
  }>
> {
  const startAt = DateTime.fromISO(input.startAtIso, {
    setZone: true,
  }).toUTC();
  if (!startAt.isValid) {
    throw new PublicQuoteSchedulingError(
      "invalid",
      "Choose a valid booking time.",
    );
  }
  const start = startAt.toJSDate();
  const keyHash = publicQuoteMutationKeyHash(input.idempotencyKey);
  const requestHash = publicQuoteMutationRequestHash({
    action: "hold",
    quoteId: input.quote.id,
    expectedRevision: input.expectedRevision,
    startAt: start.toISOString(),
  });
  const db = getDb();
  return db.transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const now = new Date();
    const [current] = await tx
      .select({
        id: quotes.id,
        contactId: quotes.contactId,
        propertyId: quotes.propertyId,
        status: quotes.status,
        revision: quotes.revision,
        expiresAt: quotes.expiresAt,
        acceptedAppointmentId: quotes.acceptedAppointmentId,
      })
      .from(quotes)
      .where(
        and(
          eq(quotes.id, input.quote.id),
          eq(quotes.shareToken, input.capabilityToken),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new PublicQuoteSchedulingError("not_found", "Quote not found.");
    }
    const replay = await readSchedulingReceipt(tx, {
      quoteId: current.id,
      action: "hold",
      keyHash,
      requestHash,
      now,
    });
    if (replay) {
      return {
        data: replay.body as {
          ok: true;
          quoteId: string;
          holdId: string;
          expiresAt: string;
          version: number;
          auditEventId: string;
        },
        replayed: true,
        responseStatus: replay.status,
      };
    }
    assertCurrentSchedulingQuote(current, input);
    if (current.acceptedAppointmentId) {
      throw new PublicQuoteSchedulingError(
        "already_booked",
        "This quote is already booked.",
      );
    }

    const context = await getQuoteScheduleContext(input.quote, tx);
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(
      context.timezone,
    );
    const startLocal = DateTime.fromJSDate(start, { zone: "utc" }).setZone(
      context.timezone,
    );
    if (
      startLocal <= nowLocal.plus({ hours: 2 }) ||
      startLocal >
        nowLocal.plus({ days: QUOTE_BOOKING_WINDOW_DAYS }).endOf("day")
    ) {
      throw new PublicQuoteSchedulingError(
        "invalid",
        "Choose an available time from the current booking calendar.",
      );
    }
    if (
      !isWithinBusinessHours(
        start,
        context.durationMinutes,
        context.businessHours,
      )
    ) {
      throw new PublicQuoteSchedulingError(
        "invalid",
        "That time is outside current business hours.",
      );
    }

    const end = new Date(
      start.getTime() +
        (context.durationMinutes + context.travelBufferMinutes) * 60_000,
    );
    const blocks = await loadScheduleBlocks(
      {
        start: new Date(start.getTime() - 24 * 60 * 60 * 1000),
        end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
        fallbackDurationMinutes: context.durationMinutes,
        fallbackTravelBufferMinutes: context.travelBufferMinutes,
      },
      tx,
    );
    const dayKey = localDayKey(start, context.timezone);
    const dayTotal = blocks.filter(
      (block) => localDayKey(block.start, context.timezone) === dayKey,
    ).length;
    if (
      (context.bookingRules.maxJobsPerDay > 0 &&
        dayTotal >= context.bookingRules.maxJobsPerDay) ||
      overlapsCount(blocks, start, end) >= context.capacity
    ) {
      throw new PublicQuoteSchedulingError(
        "slot_full",
        "That booking time is no longer available. Choose another time.",
      );
    }

    const expiresAt = new Date(now.getTime() + HOLD_WINDOW_MINUTES * 60_000);
    const [created] = await tx
      .insert(appointmentHolds)
      .values({
        fullQuoteId: current.id,
        contactId: current.contactId,
        propertyId: current.propertyId,
        startAt: start,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        status: "active",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: appointmentHolds.id,
        expiresAt: appointmentHolds.expiresAt,
      });
    if (!created?.id) {
      throw new PublicQuoteSchedulingError(
        "internal",
        "The booking time could not be reserved.",
      );
    }
    const auditEventId = await writePublicSchedulingAudit(tx, {
      action: "quote.public_hold",
      quoteId: current.id,
      correlationId: input.correlationId,
      keyHash,
      after: {
        holdId: created.id,
        quoteRevision: current.revision,
        startAt: start.toISOString(),
        expiresAt: created.expiresAt.toISOString(),
      },
      now,
    });
    const responseBody = {
      ok: true as const,
      quoteId: current.id,
      holdId: created.id,
      expiresAt: created.expiresAt.toISOString(),
      version: current.revision,
      auditEventId,
    };
    await writeSchedulingReceipt(tx, {
      quoteId: current.id,
      action: "hold",
      keyHash,
      requestHash,
      responseStatus: 201,
      responseBody,
      now,
    });
    return { data: responseBody, replayed: false, responseStatus: 201 };
  });
}

export async function bookAcceptedQuote(input: {
  quote: PublicQuoteSchedulingRow;
  capabilityToken: string;
  expectedRevision: number;
  holdId: string;
  startAtIso: string;
  customerNote?: string | null;
  idempotencyKey: string;
  correlationId: string;
}): Promise<
  PublicQuoteMutationExecution<{
    ok: true;
    quoteId: string;
    appointmentId: string;
    leadId: string | null;
    startAt: string;
    status: string;
    quoteStatus: "accepted";
    quoteRevision: number;
    pipelineStage: "won";
    auditEventId: string;
  }>
> {
  const startAt = DateTime.fromISO(input.startAtIso, {
    setZone: true,
  }).toUTC();
  if (!startAt.isValid) {
    throw new PublicQuoteSchedulingError(
      "invalid",
      "Choose a valid booking time.",
    );
  }
  const start = startAt.toJSDate();
  const customerNote = input.customerNote?.trim() || null;
  const keyHash = publicQuoteMutationKeyHash(input.idempotencyKey);
  const requestHash = publicQuoteMutationRequestHash({
    action: "book",
    quoteId: input.quote.id,
    expectedRevision: input.expectedRevision,
    startAt: start.toISOString(),
    holdId: input.holdId,
    notes: customerNote,
  });
  const context = await getQuoteScheduleContext(input.quote);
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const now = new Date();
    const [current] = await tx
      .select({
        id: quotes.id,
        contactId: quotes.contactId,
        propertyId: quotes.propertyId,
        status: quotes.status,
        revision: quotes.revision,
        expiresAt: quotes.expiresAt,
        acceptedAppointmentId: quotes.acceptedAppointmentId,
        decisionAt: quotes.decisionAt,
        decisionNotes: quotes.decisionNotes,
      })
      .from(quotes)
      .where(
        and(
          eq(quotes.id, input.quote.id),
          eq(quotes.shareToken, input.capabilityToken),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new PublicQuoteSchedulingError("not_found", "Quote not found.");
    }
    const replay = await readSchedulingReceipt(tx, {
      quoteId: current.id,
      action: "book",
      keyHash,
      requestHash,
      now,
    });
    if (replay) {
      return {
        data: replay.body as {
          ok: true;
          quoteId: string;
          appointmentId: string;
          leadId: string | null;
          startAt: string;
          status: string;
          quoteStatus: "accepted";
          quoteRevision: number;
          pipelineStage: "won";
          auditEventId: string;
        },
        replayed: true,
        responseStatus: replay.status,
      };
    }
    assertCurrentSchedulingQuote(current, input);
    if (current.acceptedAppointmentId) {
      throw new PublicQuoteSchedulingError(
        "already_booked",
        "This quote is already booked. Refresh to view the appointment.",
      );
    }

    const [hold] = await tx
      .select({
        id: appointmentHolds.id,
        fullQuoteId: appointmentHolds.fullQuoteId,
        startAt: appointmentHolds.startAt,
        status: appointmentHolds.status,
        expiresAt: appointmentHolds.expiresAt,
        contactId: appointmentHolds.contactId,
        propertyId: appointmentHolds.propertyId,
      })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, input.holdId))
      .for("update")
      .limit(1);
    if (
      !hold ||
      hold.fullQuoteId !== current.id ||
      hold.status !== "active" ||
      hold.expiresAt <= now ||
      hold.contactId !== current.contactId ||
      hold.propertyId !== current.propertyId ||
      Math.abs(hold.startAt.getTime() - start.getTime()) > 1_000
    ) {
      throw new PublicQuoteSchedulingError(
        "conflict",
        "The booking hold expired or no longer matches this quote. Choose the time again.",
      );
    }

    const [consumed] = await tx
      .update(appointmentHolds)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(appointmentHolds.id, hold.id),
          eq(appointmentHolds.status, "active"),
        ),
      )
      .returning({ id: appointmentHolds.id });
    if (!consumed) {
      throw new PublicQuoteSchedulingError(
        "conflict",
        "The booking hold was used by another request. Refresh before retrying.",
      );
    }

    const [linkedLead] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.contactId, current.contactId),
          eq(leads.propertyId, current.propertyId),
        ),
      )
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .for("update")
      .limit(1);
    if (linkedLead?.id) {
      const [existingJob] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, linkedLead.id),
            eq(appointments.type, "job"),
            ne(appointments.status, "canceled"),
          ),
        )
        .limit(1);
      if (existingJob) {
        throw new PublicQuoteSchedulingError(
          "already_booked",
          "This lead already has an active job. Refresh before booking again.",
        );
      }
    }

    const quotedTotal = Number(input.quote.total ?? 0);
    if (!Number.isFinite(quotedTotal) || quotedTotal < 0) {
      throw new PublicQuoteSchedulingError(
        "internal",
        "The quote total is invalid. Contact Stonegate before booking.",
        { retryable: false },
      );
    }
    const quotedScopeText =
      input.quote.clientScope?.trim().slice(0, 4_000) || null;
    const appointmentStatus = await resolveAutomaticAppointmentStatusForMedia({
      proposedStatus: "confirmed",
      quotedScopeText,
      contactId: current.contactId,
      database: tx,
      now,
    });
    const [appointment] = await tx
      .insert(appointments)
      .values({
        contactId: current.contactId,
        propertyId: current.propertyId,
        leadId: linkedLead?.id ?? null,
        type: "job",
        startAt: start,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        status: appointmentStatus,
        rescheduleToken: crypto.randomUUID(),
        quotedTotalCents: Math.round(quotedTotal * 100),
        quotedScopeText,
      })
      .returning({ id: appointments.id, status: appointments.status });
    if (!appointment?.id) {
      throw new PublicQuoteSchedulingError(
        "internal",
        "The appointment could not be created.",
      );
    }

    if (customerNote) {
      await tx.insert(appointmentNotes).values({
        appointmentId: appointment.id,
        body: `Customer note from quote booking: ${customerNote}`,
      });
    }

    const transitionedToAccepted = current.status === "sent";
    const nextRevision = current.revision + 1;
    const [updatedQuote] = await tx
      .update(quotes)
      .set({
        status: "accepted",
        decisionAt: transitionedToAccepted ? now : current.decisionAt,
        decisionNotes: transitionedToAccepted
          ? customerNote
            ? `Scheduling note: ${customerNote}`
            : "Approved and booked from quote page."
          : current.decisionNotes,
        acceptedAppointmentId: appointment.id,
        revision: nextRevision,
        updatedAt: now,
      })
      .where(
        and(eq(quotes.id, current.id), eq(quotes.revision, current.revision)),
      )
      .returning({
        id: quotes.id,
        status: quotes.status,
        revision: quotes.revision,
      });
    if (!updatedQuote) {
      throw new PublicQuoteSchedulingError(
        "conflict",
        "The quote changed while booking. Refresh before retrying.",
      );
    }

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pipeline:${current.contactId}`}, 0))`,
    );
    const [existingPipeline] = await tx
      .select({ stage: crmPipeline.stage })
      .from(crmPipeline)
      .where(eq(crmPipeline.contactId, current.contactId))
      .for("update")
      .limit(1);
    await tx
      .insert(crmPipeline)
      .values({ contactId: current.contactId, stage: "won", updatedAt: now })
      .onConflictDoUpdate({
        target: crmPipeline.contactId,
        set: { stage: "won", updatedAt: now },
      });

    const contactLeadIds = tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.contactId, current.contactId));
    await tx
      .update(leadAutomationStates)
      .set({
        followupState: "stopped",
        followupStep: 0,
        nextFollowupAt: null,
        updatedAt: now,
      })
      .where(inArray(leadAutomationStates.leadId, contactLeadIds));
    await tx.delete(outboxEvents).where(
      and(
        eq(outboxEvents.type, "followup.send"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`(${outboxEvents.payload}->>'leadId') IN (
          SELECT ${leads.id}::text FROM ${leads}
          WHERE ${leads.contactId} = ${current.contactId}
        )`,
      ),
    );

    const [appointmentEvent] = await tx
      .insert(outboxEvents)
      .values({
        type: "estimate.requested",
        payload: {
          appointmentId: appointment.id,
          leadId: linkedLead?.id ?? null,
          services: input.quote.services,
          quoteId: current.id,
          source: "public_quote",
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    const [pipelineEvent] = await tx
      .insert(outboxEvents)
      .values({
        type: "pipeline.auto_stage_change",
        payload: {
          contactId: current.contactId,
          fromStage: existingPipeline?.stage ?? null,
          toStage: "won",
          reason: "quote.accepted.booked",
          meta: { quoteId: current.id, appointmentId: appointment.id },
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    const decisionEvent = transitionedToAccepted
      ? await tx
          .insert(outboxEvents)
          .values({
            type: "quote.decision",
            payload: {
              quoteId: current.id,
              decision: "accepted",
              source: "customer",
              notes: customerNote,
            },
            createdAt: now,
          })
          .returning({ id: outboxEvents.id })
      : [];
    if (!appointmentEvent?.id || !pipelineEvent?.id) {
      throw new PublicQuoteSchedulingError(
        "internal",
        "The booking workflow could not be queued.",
      );
    }

    const auditEventId = await writePublicSchedulingAudit(tx, {
      action: "quote.public_booked",
      quoteId: current.id,
      correlationId: input.correlationId,
      keyHash,
      before: {
        status: current.status,
        revision: current.revision,
        acceptedAppointmentId: current.acceptedAppointmentId,
        pipelineStage: existingPipeline?.stage ?? null,
      },
      after: {
        status: updatedQuote.status,
        revision: updatedQuote.revision,
        acceptedAppointmentId: appointment.id,
        pipelineStage: "won",
      },
      metadata: {
        appointmentId: appointment.id,
        leadId: linkedLead?.id ?? null,
        holdId: hold.id,
        appointmentEventId: appointmentEvent.id,
        pipelineEventId: pipelineEvent.id,
        decisionEventId: decisionEvent[0]?.id ?? null,
      },
      now,
    });
    const responseBody = {
      ok: true as const,
      quoteId: current.id,
      appointmentId: appointment.id,
      leadId: linkedLead?.id ?? null,
      startAt: start.toISOString(),
      status: appointment.status,
      quoteStatus: "accepted" as const,
      quoteRevision: updatedQuote.revision,
      pipelineStage: "won" as const,
      auditEventId,
    };
    await writeSchedulingReceipt(tx, {
      quoteId: current.id,
      action: "book",
      keyHash,
      requestHash,
      responseStatus: 201,
      responseBody,
      now,
    });
    return { data: responseBody, replayed: false, responseStatus: 201 };
  });

  await runBestEffortQuoteHoldCleanup(
    () =>
      db
        .update(appointmentHolds)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(appointmentHolds.fullQuoteId, input.quote.id),
            eq(appointmentHolds.status, "active"),
            sql`${appointmentHolds.expiresAt} <= now()`,
          ),
        ),
    { quoteId: input.quote.id, appointmentId: result.data.appointmentId },
  );
  return result;
}
