import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, eq, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  crmPipeline,
  getDb,
  leads,
  outboxEvents,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import {
  acquireScheduleConflictLock,
  inspectScheduleConflicts,
} from "@/lib/appointment-schedule-conflicts";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { sendConversion } from "@/lib/ga";
import { getBookingRulesPolicy, normalizePostalCode } from "@/lib/policy";
import { normalizeName, normalizePhone, resolveClientIp } from "../utils";
import {
  PublicContactPersistenceError,
  upsertContact,
  upsertProperty,
} from "../persistence";
import {
  DEFAULT_TRAVEL_BUFFER_MIN,
  resolveAppointmentTiming,
} from "../scheduling";

const rateLimiter = new LRUCache<
  string,
  { count: number; operationKeyHashes: Set<string> }
>({
  max: 500,
  ttl: 60_000,
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

type LeadIntakeResponse = {
  ok: true;
  leadId: string;
  appointmentId: string | null;
  rescheduleToken: string | null;
  startAt: string | null;
  durationMinutes: number | null;
  travelBufferMinutes: number | null;
  timeWindow: string | null;
  preferredDate: string | null;
  /** Absent only on a receipt written before schedule admission was unified. */
  schedulingReviewRequired?: boolean;
  auditEventId: string;
};

class LeadIntakeIdempotencyError extends Error {
  constructor(
    readonly code: "idempotency_conflict" | "idempotency_receipt_invalid",
    readonly status: 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "LeadIntakeIdempotencyError";
  }
}

function normalizeIdempotencyKey(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  return IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLeadIntakeResponse(value: unknown): value is LeadIntakeResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const nullableString = (entry: unknown): entry is string | null =>
    entry === null || typeof entry === "string";
  const nullablePositiveInteger = (entry: unknown): entry is number | null =>
    entry === null ||
    (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
  return (
    candidate["ok"] === true &&
    typeof candidate["leadId"] === "string" &&
    candidate["leadId"].length > 0 &&
    typeof candidate["auditEventId"] === "string" &&
    candidate["auditEventId"].length > 0 &&
    nullableString(candidate["appointmentId"]) &&
    nullableString(candidate["rescheduleToken"]) &&
    nullableString(candidate["startAt"]) &&
    nullablePositiveInteger(candidate["durationMinutes"]) &&
    nullablePositiveInteger(candidate["travelBufferMinutes"]) &&
    nullableString(candidate["timeWindow"]) &&
    nullableString(candidate["preferredDate"]) &&
    (candidate["schedulingReviewRequired"] === undefined ||
      typeof candidate["schedulingReviewRequired"] === "boolean")
  );
}

const ALLOWED_ORIGIN =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function applyCors(
  response: NextResponse,
  origin = ALLOWED_ORIGIN,
): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Idempotency-Key",
  );
  response.headers.set(
    "Access-Control-Expose-Headers",
    "X-Correlation-Id, Idempotency-Replayed",
  );
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init));
}

export function OPTIONS(): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }));
}

const optionalTrackingValue = z.string().trim().max(256).optional();
const LeadSchema = z
  .object({
    services: z
      .array(z.string().trim().min(2).max(80))
      .min(1)
      .max(20)
      .optional(),
    service: z.string().trim().min(2).max(80).optional(),
    name: z.string().trim().min(2).max(160),
    phone: z.string().trim().min(7).max(40),
    email: z.string().trim().email().max(320).optional(),
    addressLine1: z.string().trim().min(5).max(240),
    city: z.string().trim().min(2).max(120),
    state: z.string().trim().length(2),
    postalCode: z.string().trim().min(3).max(16),
    notes: z.string().trim().max(1000).optional(),
    scheduling: z
      .object({
        preferredDate: z.string().trim().max(40).optional(),
        alternateDate: z.string().trim().max(40).optional(),
        timeWindow: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
    appointmentType: z.enum(["in_person_estimate", "web_lead"]).optional(),
    utm: z
      .object({
        source: optionalTrackingValue,
        medium: optionalTrackingValue,
        campaign: optionalTrackingValue,
        term: optionalTrackingValue,
        content: optionalTrackingValue,
        gclid: optionalTrackingValue,
        fbclid: optionalTrackingValue,
      })
      .strict()
      .optional(),
    gclid: optionalTrackingValue,
    fbclid: optionalTrackingValue,
    consent: z.boolean().optional(),
    hp_company: z.string().max(256).optional(),
  })
  .strict();

function checkRateLimit(key: string, operationKeyHash: string): boolean {
  // Disable rate limiting in E2E test environment to allow parallel test execution
  if (process.env["NODE_ENV"] === "test" || process.env["E2E_RUN_ID"]) {
    return false;
  }

  if (key === "unknown") {
    return false;
  }

  const existing = rateLimiter.get(key);
  if (existing?.operationKeyHashes.has(operationKeyHash)) {
    return false;
  }
  if (existing && existing.count >= 3) {
    return true;
  }

  if (existing) {
    existing.count += 1;
    existing.operationKeyHashes.add(operationKeyHash);
    rateLimiter.set(key, existing, { ttl: 60_000 });
  } else {
    rateLimiter.set(
      key,
      { count: 1, operationKeyHashes: new Set([operationKeyHash]) },
      { ttl: 60_000 },
    );
  }

  return false;
}

function normalizeServiceSlug(value: string): string {
  const raw = value.trim();
  const key = raw.toLowerCase();

  switch (key) {
    case "rubbish":
    case "trash":
    case "garbage":
    case "household waste":
    case "household_waste":
    case "household-waste":
      return "single-item";
    case "single_item":
      return "single-item";
    case "yard_waste":
      return "yard-waste";
    case "construction_debris":
      return "construction-debris";
    case "hot_tub":
      return "hot-tub";
    default:
      return raw;
  }
}

function normalizeServiceSelection(raw: string[]): string[] {
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const cleaned = normalizeServiceSlug(entry);
    if (!cleaned.length) continue;
    if (!normalized.includes(cleaned)) normalized.push(cleaned);
  }
  return normalized;
}

export async function POST(request: NextRequest) {
  const correlationId = randomUUID();
  const ip = resolveClientIp(request);
  const idempotencyKey = normalizeIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey) {
    return corsJson(
      {
        ok: false,
        error: "idempotency_key_required",
        message: "Refresh the form before submitting your request again.",
      },
      { status: 422, headers: { "x-correlation-id": correlationId } },
    );
  }
  const operationKeyHash = sha256(idempotencyKey);

  if (checkRateLimit(ip, operationKeyHash)) {
    return corsJson(
      { error: "rate_limited" },
      { status: 429, headers: { "x-correlation-id": correlationId } },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request could not be read.",
            400,
          );
    return corsJson(
      { ok: false, error: failure.code, message: failure.message },
      {
        status: failure.status,
        headers: { "x-correlation-id": correlationId },
      },
    );
  }
  const parsedPayload = LeadSchema.safeParse(body);
  if (!parsedPayload.success) {
    return corsJson(
      { error: "invalid_payload", message: parsedPayload.error.message },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    );
  }

  const payload = parsedPayload.data;
  if (payload.hp_company && payload.hp_company.trim().length > 0) {
    return corsJson(
      { ok: true },
      { status: 200, headers: { "x-correlation-id": correlationId } },
    );
  }

  const servicesRequested = normalizeServiceSelection(
    payload.services ?? (payload.service ? [payload.service] : []),
  );
  if (!servicesRequested.length) {
    return corsJson(
      {
        error: "invalid_payload",
        message: "At least one service must be selected.",
      },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    );
  }

  const appointmentType = payload.appointmentType ?? "web_lead";
  const scheduling = payload.scheduling ?? {};
  const timing = resolveAppointmentTiming(
    scheduling.preferredDate ?? null,
    scheduling.timeWindow ?? null,
  );
  const bookingRules = await getBookingRulesPolicy();
  const travelBufferMinutes =
    typeof bookingRules.bufferMinutes === "number" &&
    Number.isFinite(bookingRules.bufferMinutes)
      ? bookingRules.bufferMinutes
      : DEFAULT_TRAVEL_BUFFER_MIN;
  const rescheduleToken =
    appointmentType === "in_person_estimate" ? nanoid(24) : null;

  let normalizedPhone: ReturnType<typeof normalizePhone>;
  try {
    normalizedPhone = normalizePhone(payload.phone);
  } catch {
    return corsJson(
      { error: "invalid_phone" },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    );
  }

  const email = payload.email?.trim().toLowerCase();
  const { firstName, lastName } = normalizeName(payload.name);
  const trimmedCity = payload.city.trim();
  const normalizedState = payload.state.trim().toUpperCase();
  const addressLine1 = payload.addressLine1.trim();
  const postalCode = payload.postalCode.trim();
  const normalizedPostalCode = normalizePostalCode(postalCode);

  if (normalizedState !== "GA") {
    return corsJson(
      {
        ok: false,
        error: "out_of_area",
        message: "Thanks for reaching out. We currently serve Georgia only.",
      },
      { status: 200, headers: { "x-correlation-id": correlationId } },
    );
  }
  void normalizedPostalCode;

  const referrer = request.headers.get("referer") ?? null;
  const requestHash = sha256(
    JSON.stringify({
      services: servicesRequested,
      appointmentType,
      scheduling,
      firstName,
      lastName,
      phoneE164: normalizedPhone.e164,
      email: email ?? null,
      addressLine1,
      city: trimmedCity,
      state: normalizedState,
      postalCode,
      notes: payload.notes?.trim() || null,
      utm: payload.utm ?? {},
      gclid: payload.gclid ?? null,
      fbclid: payload.fbclid ?? null,
      consent: payload.consent ?? null,
    }),
  );
  const db = getDb();

  try {
    const leadResult = await db.transaction(async (tx) => {
      // All channels that can claim operational capacity share this lock. It
      // closes the race where two otherwise-independent intake surfaces both
      // observe the final free unit before either transaction commits.
      await acquireScheduleConflictLock(tx);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lead-intake:${operationKeyHash}`}, 0))`,
      );
      const [existing] = await tx
        .select({
          requestHash: leads.intakeRequestHash,
          response: leads.intakeResponse,
        })
        .from(leads)
        .where(eq(leads.intakeOperationKeyHash, operationKeyHash))
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new LeadIntakeIdempotencyError(
            "idempotency_conflict",
            409,
            "This request key was already used with different form details.",
          );
        }
        if (!isLeadIntakeResponse(existing.response)) {
          throw new LeadIntakeIdempotencyError(
            "idempotency_receipt_invalid",
            500,
            "The original request receipt is incomplete. Contact Stonegate before retrying.",
          );
        }
        return {
          response: existing.response,
          replayed: true,
          appointment: null,
        };
      }

      const contact = await upsertContact(tx, {
        firstName,
        lastName,
        email,
        phoneRaw: normalizedPhone.raw,
        phoneE164: normalizedPhone.e164,
        source: "web",
      });

      await tx
        .insert(crmPipeline)
        .values({ contactId: contact.id, stage: "new" })
        .onConflictDoNothing({ target: crmPipeline.contactId });

      const property = await upsertProperty(tx, {
        contactId: contact.id,
        addressLine1,
        city: trimmedCity,
        state: normalizedState,
        postalCode,
        gated: false,
      });
      const scheduleDecision =
        appointmentType === "in_person_estimate" && timing.startAt
          ? await inspectScheduleConflicts(tx, {
              startAt: timing.startAt,
              durationMinutes: timing.durationMinutes,
              travelBufferMinutes,
              capacity: getAppointmentCapacity(),
            })
          : null;
      const schedulingReviewRequired = scheduleDecision?.conflict === true;
      const utm = payload.utm ?? {};
      const [lead] = await tx
        .insert(leads)
        .values({
          contactId: contact.id,
          propertyId: property.id,
          servicesRequested,
          notes: payload.notes,
          status:
            appointmentType === "in_person_estimate" &&
            !schedulingReviewRequired
              ? "scheduled"
              : "new",
          source: "web",
          utmSource: utm.source,
          utmMedium: utm.medium,
          utmCampaign: utm.campaign,
          utmTerm: utm.term,
          utmContent: utm.content,
          gclid: payload.gclid ?? utm.gclid,
          fbclid: payload.fbclid ?? utm.fbclid,
          referrer: referrer ?? undefined,
          intakeOperationKeyHash: operationKeyHash,
          intakeRequestHash: requestHash,
          formPayload: {
            services: servicesRequested,
            appointmentType,
            scheduling,
            addressLine1,
            city: trimmedCity,
            state: normalizedState,
            postalCode,
            notes: payload.notes,
            utm,
          },
        })
        .returning({ id: leads.id });
      if (!lead) {
        throw new Error("Failed to record lead");
      }

      await tx.insert(outboxEvents).values({
        type: "lead.alert",
        payload: { leadId: lead.id, source: "web" },
      });

      let appointmentRecord: {
        id: string;
        startAt: Date | null;
        durationMinutes: number;
        travelBufferMinutes: number;
        rescheduleToken: string;
        calendarEventId: string | null;
      } | null = null;
      if (
        appointmentType === "in_person_estimate" &&
        !schedulingReviewRequired
      ) {
        const token = rescheduleToken ?? nanoid(12);
        const [appointment] = await tx
          .insert(appointments)
          .values({
            contactId: contact.id,
            propertyId: property.id,
            leadId: lead.id,
            type: "estimate",
            startAt: timing.startAt ?? null,
            durationMinutes: timing.durationMinutes,
            status: "requested",
            rescheduleToken: token,
            travelBufferMinutes,
          })
          .returning({ id: appointments.id });
        appointmentRecord = appointment?.id
          ? {
              id: appointment.id,
              startAt: timing.startAt,
              durationMinutes: timing.durationMinutes,
              travelBufferMinutes,
              rescheduleToken: token,
              calendarEventId: null,
            }
          : null;
      }

      const eventType = appointmentRecord
        ? "estimate.requested"
        : "lead.created";
      await tx.insert(outboxEvents).values({
        type: eventType,
        payload: {
          leadId: lead.id,
          services: servicesRequested,
          appointmentType,
          scheduling,
          source: "web",
          appointmentId: appointmentRecord?.id ?? null,
          schedulingReviewRequired,
        },
      });

      const auditEventId = randomUUID();
      await tx.insert(auditLogs).values({
        id: auditEventId,
        actorType: "system",
        actorLabel: "public-lead-intake",
        correlationId,
        outcome: "succeeded",
        surface: "/estimate",
        idempotencyKeyHash: operationKeyHash,
        action: "lead.public_created",
        entityType: "lead",
        entityId: lead.id,
        meta: sanitizeAuditMetadata({
          eventId: auditEventId,
          correlationId,
          source: "web",
          contactId: contact.id,
          propertyId: property.id,
          appointmentId: appointmentRecord?.id ?? null,
          appointmentType,
          services: servicesRequested,
          durableOutbox: true,
          schedulingReviewRequired,
          scheduleConflictFingerprint: scheduleDecision?.fingerprint ?? null,
        }),
      });
      const response: LeadIntakeResponse = {
        ok: true,
        leadId: lead.id,
        appointmentId: appointmentRecord?.id ?? null,
        rescheduleToken: appointmentRecord?.rescheduleToken ?? null,
        startAt: appointmentRecord?.startAt?.toISOString() ?? null,
        durationMinutes: appointmentRecord?.durationMinutes ?? null,
        travelBufferMinutes: appointmentRecord?.travelBufferMinutes ?? null,
        timeWindow: scheduling.timeWindow ?? null,
        preferredDate: scheduling.preferredDate ?? null,
        schedulingReviewRequired,
        auditEventId,
      };
      const [storedReceipt] = await tx
        .update(leads)
        .set({ intakeResponse: response })
        .where(
          and(
            eq(leads.id, lead.id),
            eq(leads.intakeOperationKeyHash, operationKeyHash),
          ),
        )
        .returning({ id: leads.id });
      if (!storedReceipt) {
        throw new Error("Failed to store lead intake receipt");
      }
      return { response, replayed: false, appointment: appointmentRecord };
    });

    if (!leadResult.replayed) {
      console.info("[lead-intake] new lead", {
        leadId: leadResult.response.leadId,
        services: servicesRequested,
        appointmentType,
        scheduling,
        correlationId,
      });
      void sendConversion("generate_lead", {
        params: {
          source: payload.utm?.source ?? "web",
          medium: payload.utm?.medium ?? "form",
          campaign: payload.utm?.campaign,
          service: servicesRequested[0],
        },
      });

      if (appointmentType === "in_person_estimate" && leadResult.appointment) {
        console.info("[lead-intake] appointment_scheduled", {
          appointmentId: leadResult.appointment.id,
          leadId: leadResult.response.leadId,
          note: "Calendar event creation will be handled by background job processor",
          correlationId,
        });
      }
    }

    return corsJson(leadResult.response, {
      status: 201,
      headers: {
        "x-correlation-id": correlationId,
        ...(leadResult.replayed ? { "idempotency-replayed": "true" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof LeadIntakeIdempotencyError) {
      return corsJson(
        {
          ok: false,
          error: error.code,
          message: error.message,
          retryable: false,
        },
        {
          status: error.status,
          headers: { "x-correlation-id": correlationId },
        },
      );
    }
    if (error instanceof PublicContactPersistenceError) {
      return corsJson(
        {
          ok: false,
          error: error.publicCode,
          message: error.publicMessage,
        },
        {
          status: error.status,
          headers: { "x-correlation-id": correlationId },
        },
      );
    }
    throw error;
  }
}
