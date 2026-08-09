import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, gte, lte, ne, or, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointmentNotes,
  appointments,
  contactProperties,
  contacts,
  crmPipeline,
  crmTasks,
  getDb,
  instantQuotes,
  leads,
  outboxEvents,
  properties,
  teamMembers,
} from "@/db";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest } from "@/lib/audit";
import { getBusinessHoursPolicy, getBookingRulesPolicy } from "@/lib/policy";
import {
  getAutonomousBookingDurationMinutes,
  validateAutonomousBookingStart,
} from "@/lib/after-hours-autonomy";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import {
  acquireScheduleConflictLock,
  decideScheduleConflictOverride,
  inspectScheduleConflicts,
  type ScheduleConflictDecision,
} from "@/lib/appointment-schedule-conflicts";
import { resolveAutomaticAppointmentStatusForMedia } from "@/lib/appointment-media";
import { resolveEasternAppointmentTime } from "@/lib/appointment-time";
import {
  getCalendarMutationCorrelationId,
  insertCalendarMutationSuccessAudit,
} from "@/lib/calendar-mutation-audit";
import { resolveOrCreateContactProperty } from "@/lib/property-write";
import {
  InstantQuoteHandoffFailure,
  loadInstantQuoteTeamHandoff,
} from "@/lib/instant-quote-team-handoff";
import {
  isValidSoldByOverrideCode,
  normalizeSoldByMemberId,
  soldByChangeRequiresOverride,
} from "@/lib/sold-by-override";
import { isAdminRequest } from "../../../web/admin";

function parseStartAt(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  const hasTimezone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
  if (!hasTimezone && timezone === "America/New_York") {
    const local =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00(?:\.0{1,3})?)?$/u.exec(trimmed);
    if (!local?.[1] || !local[2]) return null;
    const resolved = resolveEasternAppointmentTime(local[1], local[2]);
    return resolved.ok ? resolved.value : null;
  }
  const dt = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

type BookRequest = {
  contactId?: string;
  propertyId?: string;
  appointmentType?: string;
  startAt?: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
  quotedTotalCents?: number;
  bookingDetails?: unknown;
  notes?: string;
  soldByMemberId?: string | null;
  soldByOverrideCode?: string | null;
  assignedAssociateMemberId?: string | null;
  marketingMemberId?: string | null;
  source?: string;
  autonomousConversationAt?: string | null;
  instantQuoteId?: string | null;
  conflictOverrideReason?: string | null;
  conflictAcknowledgement?: string | null;
  conflictFingerprint?: string | null;
};

const PLACEHOLDER_CITY = "Unknown";
const PLACEHOLDER_STATE = "NA";
const PLACEHOLDER_POSTAL_CODE = "00000";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class BookingScheduleConflictError extends Error {
  constructor(
    readonly decision: ScheduleConflictDecision,
    readonly code:
      | "schedule_conflict"
      | "schedule_conflict_override_reason_required"
      | "schedule_conflict_override_stale",
    message: string,
  ) {
    super(message);
    this.name = "BookingScheduleConflictError";
  }
}

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function requiresAutonomousBookingRulesForSource(source: string): boolean {
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const tokens = normalized.split("_").filter(Boolean);
  return (
    tokens.includes("auto") ||
    tokens.includes("autopilot") ||
    tokens.includes("agent") ||
    tokens.includes("assistant") ||
    tokens.includes("bot") ||
    tokens.includes("system") ||
    normalized.includes("autonomous")
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "bookings.manage");
  if (permissionError) return permissionError;

  let payload: BookRequest = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = (await request.json().catch(() => ({}))) as BookRequest;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const bookingDetailsValue = formString(form, "bookingDetails");
    const durationValue = formString(form, "durationMinutes");
    const quotedTotalValue = formString(form, "quotedTotalCents");
    const servicesValue = formString(form, "services");
    const travelBufferValue = formString(form, "travelBufferMinutes");
    payload = {
      contactId: formString(form, "contactId"),
      propertyId: formString(form, "propertyId"),
      appointmentType: formString(form, "appointmentType"),
      startAt: formString(form, "startAt"),
      durationMinutes: durationValue ? Number(durationValue) : undefined,
      travelBufferMinutes: travelBufferValue
        ? Number(travelBufferValue)
        : undefined,
      quotedTotalCents: quotedTotalValue ? Number(quotedTotalValue) : undefined,
      bookingDetails: bookingDetailsValue
        ? JSON.parse(bookingDetailsValue)
        : undefined,
      notes: formString(form, "notes"),
      soldByMemberId: formString(form, "soldByMemberId"),
      soldByOverrideCode: formString(form, "soldByOverrideCode"),
      assignedAssociateMemberId: formString(form, "assignedAssociateMemberId"),
      marketingMemberId: formString(form, "marketingMemberId"),
      source: formString(form, "source"),
      autonomousConversationAt: formString(form, "autonomousConversationAt"),
      instantQuoteId: formString(form, "instantQuoteId"),
      conflictOverrideReason: formString(form, "conflictOverrideReason"),
      conflictAcknowledgement: formString(form, "conflictAcknowledgement"),
      conflictFingerprint: formString(form, "conflictFingerprint"),
      services: servicesValue
        ? servicesValue
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    };
  }

  const contactId =
    typeof payload.contactId === "string" && payload.contactId.length
      ? payload.contactId
      : null;
  const propertyId =
    typeof payload.propertyId === "string" && payload.propertyId.length
      ? payload.propertyId
      : null;
  const startAtIso =
    typeof payload.startAt === "string" && payload.startAt.length
      ? payload.startAt
      : null;
  const appointmentTypeRaw =
    typeof payload.appointmentType === "string"
      ? payload.appointmentType.trim()
      : "";
  const appointmentType =
    appointmentTypeRaw.toLowerCase() === "in_person_quote"
      ? "in_person_quote"
      : "job";
  const source =
    typeof payload.source === "string" && payload.source.trim().length > 0
      ? payload.source.trim()
      : "manual_booking";
  const requiresAutonomousBookingRules =
    requiresAutonomousBookingRulesForSource(source);
  if (
    payload.durationMinutes !== undefined &&
    (typeof payload.durationMinutes !== "number" ||
      !Number.isInteger(payload.durationMinutes) ||
      payload.durationMinutes < 15 ||
      payload.durationMinutes > 8 * 60)
  ) {
    return NextResponse.json(
      {
        error: "invalid_duration",
        message: "Appointment duration must be 15 to 480 minutes.",
      },
      { status: 422 },
    );
  }
  if (
    payload.travelBufferMinutes !== undefined &&
    (typeof payload.travelBufferMinutes !== "number" ||
      !Number.isInteger(payload.travelBufferMinutes) ||
      payload.travelBufferMinutes < 0 ||
      payload.travelBufferMinutes > 6 * 60)
  ) {
    return NextResponse.json(
      {
        error: "invalid_travel_buffer",
        message: "Travel buffer must be 0 to 360 minutes.",
      },
      { status: 422 },
    );
  }
  const requestedDurationMinutes =
    typeof payload.durationMinutes === "number" &&
    Number.isFinite(payload.durationMinutes) &&
    payload.durationMinutes > 0
      ? Math.floor(payload.durationMinutes)
      : null;
  const durationMinutes = requiresAutonomousBookingRules
    ? getAutonomousBookingDurationMinutes()
    : (requestedDurationMinutes ?? getAutonomousBookingDurationMinutes());
  const travelBufferMinutes =
    typeof payload.travelBufferMinutes === "number" &&
    payload.travelBufferMinutes >= 0
      ? payload.travelBufferMinutes
      : 30;
  const quotedTotalCents =
    typeof payload.quotedTotalCents === "number" &&
    Number.isFinite(payload.quotedTotalCents) &&
    Number.isInteger(payload.quotedTotalCents) &&
    payload.quotedTotalCents >= 0
      ? payload.quotedTotalCents
      : null;
  const bookingDetails =
    payload.bookingDetails === undefined
      ? null
      : parseAppointmentBookingDetails(payload.bookingDetails);
  const notes =
    typeof payload.notes === "string" && payload.notes.trim().length > 0
      ? payload.notes.trim()
      : null;
  const soldByMemberId = normalizeSoldByMemberId(payload.soldByMemberId);
  const soldByOverrideCode =
    typeof payload.soldByOverrideCode === "string"
      ? payload.soldByOverrideCode.trim()
      : null;
  const assignedAssociateMemberId = normalizeSoldByMemberId(
    payload.assignedAssociateMemberId,
  );
  const marketingMemberId =
    typeof payload.marketingMemberId === "string" &&
    payload.marketingMemberId.trim().length > 0
      ? payload.marketingMemberId.trim()
      : null;
  const autonomousConversationAt =
    typeof payload.autonomousConversationAt === "string" &&
    payload.autonomousConversationAt.trim().length > 0
      ? payload.autonomousConversationAt.trim()
      : null;
  const instantQuoteId =
    typeof payload.instantQuoteId === "string" &&
    payload.instantQuoteId.trim().length > 0
      ? payload.instantQuoteId.trim()
      : null;
  const conflictOverrideReason =
    typeof payload.conflictOverrideReason === "string"
      ? payload.conflictOverrideReason.trim()
      : "";
  const conflictAcknowledgement =
    typeof payload.conflictAcknowledgement === "string"
      ? payload.conflictAcknowledgement.trim()
      : "";
  const conflictFingerprint =
    typeof payload.conflictFingerprint === "string"
      ? payload.conflictFingerprint.trim()
      : "";
  const conflictOverrideRequested = Boolean(
    conflictOverrideReason || conflictAcknowledgement || conflictFingerprint,
  );

  if (conflictOverrideRequested) {
    const overridePermissionError = await requirePermission(
      request,
      "appointments.override_conflicts",
    );
    if (overridePermissionError) return overridePermissionError;
  }

  if (!contactId || !startAtIso) {
    return NextResponse.json(
      { error: "contact_and_start_required" },
      { status: 400 },
    );
  }

  if (instantQuoteId && !UUID_PATTERN.test(instantQuoteId)) {
    return NextResponse.json(
      {
        error: "invalid_instant_quote_id",
        message: "Select a valid instant quote before booking.",
      },
      { status: 422 },
    );
  }

  if (payload.bookingDetails !== undefined && !bookingDetails) {
    return NextResponse.json(
      { error: "invalid_booking_details" },
      { status: 400 },
    );
  }

  const quotedTotalError = validateQuotedTotalForBookingDetails(
    bookingDetails,
    quotedTotalCents,
  );
  if (quotedTotalError) {
    return NextResponse.json({ error: quotedTotalError }, { status: 400 });
  }

  const services =
    Array.isArray(payload.services) && payload.services.length
      ? payload.services.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        )
      : [];

  const db = getDb();
  const [businessHours, bookingRules] = await Promise.all([
    getBusinessHoursPolicy(db),
    getBookingRulesPolicy(db),
  ]);
  const timezone =
    businessHours.timezone ||
    process.env["APPOINTMENT_TIMEZONE"] ||
    "America/New_York";
  const startAt = parseStartAt(startAtIso, timezone);
  if (!startAt) {
    return NextResponse.json(
      {
        error: "invalid_startAt",
        message:
          "Choose a valid Eastern appointment time. Times skipped or repeated by daylight saving time are not accepted.",
      },
      { status: 422 },
    );
  }
  const actor = getAuditActorFromRequest(request);
  const correlationId = getCalendarMutationCorrelationId(request);
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      await acquireScheduleConflictLock(tx);
      let resolvedPropertyId = propertyId;
      let resolvedLeadId: string | null = null;
      let createdPropertyId: string | null = null;
      let resolvedSoldByMemberId = soldByMemberId;
      if (instantQuoteId) {
        // Lock the quote before reading the complete relationship snapshot so
        // contact/property reassignment cannot race this booking.
        await tx
          .select({ id: instantQuotes.id })
          .from(instantQuotes)
          .where(eq(instantQuotes.id, instantQuoteId))
          .for("update")
          .limit(1);
        const handoff = await loadInstantQuoteTeamHandoff(tx, instantQuoteId);
        if (
          handoff.contactId !== contactId ||
          !propertyId ||
          handoff.propertyId !== propertyId
        ) {
          throw new InstantQuoteHandoffFailure(
            "instant_quote_relationship_missing",
            "The instant quote no longer matches this customer and property. Open the quote again before booking.",
            409,
          );
        }
        const [lockedLead] = await tx
          .select({
            id: leads.id,
            instantQuoteId: leads.instantQuoteId,
            contactId: leads.contactId,
            propertyId: leads.propertyId,
          })
          .from(leads)
          .where(eq(leads.id, handoff.leadId))
          .for("update")
          .limit(1);
        if (
          !lockedLead ||
          lockedLead.instantQuoteId !== instantQuoteId ||
          lockedLead.contactId !== contactId ||
          lockedLead.propertyId !== propertyId
        ) {
          throw new InstantQuoteHandoffFailure(
            "instant_quote_relationship_missing",
            "The instant quote lead changed while booking. Refresh the quote and try again.",
            409,
          );
        }
        const [existingBooking] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.leadId, lockedLead.id),
              ne(appointments.status, "canceled"),
            ),
          )
          .limit(1);
        if (existingBooking?.id) {
          throw new Error("instant_quote_already_booked");
        }
        resolvedLeadId = lockedLead.id;
      }
      const [contact] = await tx
        .select({ salespersonMemberId: contacts.salespersonMemberId })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      const baselineSoldByMemberId =
        assignedAssociateMemberId ??
        normalizeSoldByMemberId(contact?.salespersonMemberId);

      if (!resolvedSoldByMemberId && source === "sales_autopilot") {
        try {
          const [austin] = await tx
            .select({ id: teamMembers.id })
            .from(teamMembers)
            .where(sql`lower(${teamMembers.name}) like ${"austin%"}`)
            .limit(1);
          resolvedSoldByMemberId = austin?.id ?? null;
        } catch {
          resolvedSoldByMemberId = null;
        }
      }

      if (
        soldByChangeRequiresOverride({
          nextSoldByMemberId: resolvedSoldByMemberId,
          assignedSalespersonMemberId: baselineSoldByMemberId,
        })
      ) {
        if (!process.env["SOLD_BY_OVERRIDE_CODE"]?.trim()) {
          throw new Error("sold_by_override_unconfigured");
        }
        if (!isValidSoldByOverrideCode(soldByOverrideCode)) {
          throw new Error("sold_by_override_code_required");
        }
      }

      if (!resolvedPropertyId) {
        const [existing] = await tx
          .select({ id: properties.id })
          .from(properties)
          .leftJoin(
            contactProperties,
            and(
              eq(contactProperties.propertyId, properties.id),
              eq(contactProperties.contactId, contactId),
            ),
          )
          .where(
            or(
              eq(properties.contactId, contactId),
              eq(contactProperties.contactId, contactId),
            ),
          )
          .orderBy(desc(properties.createdAt))
          .limit(1);

        if (existing?.id) {
          resolvedPropertyId = existing.id;
        } else {
          const short = contactId.split("-")[0] ?? contactId.slice(0, 8);
          const placeholderId = nanoid(6);
          const placeholder = await resolveOrCreateContactProperty(tx, {
            contactId,
            // A random suffix prevents unknown locations from collapsing into
            // one canonical property before staff supply an address.
            addressLine1: `[Manual booking ${short}] Address pending (${placeholderId})`,
            addressLine2: null,
            city: PLACEHOLDER_CITY,
            state: PLACEHOLDER_STATE,
            postalCode: PLACEHOLDER_POSTAL_CODE,
            gated: false,
            now,
          });
          resolvedPropertyId = placeholder.property.id;
          createdPropertyId = placeholder.propertyCreated
            ? placeholder.property.id
            : null;
        }
      }

      if (!resolvedPropertyId) {
        throw new Error("property_create_failed");
      }

      const [accessibleProperty] = await tx
        .select({ id: properties.id })
        .from(properties)
        .leftJoin(
          contactProperties,
          and(
            eq(contactProperties.propertyId, properties.id),
            eq(contactProperties.contactId, contactId),
          ),
        )
        .where(
          and(
            eq(properties.id, resolvedPropertyId),
            or(
              eq(properties.contactId, contactId),
              eq(contactProperties.contactId, contactId),
            ),
          ),
        )
        .limit(1);

      if (!accessibleProperty) {
        throw new Error("property_contact_mismatch");
      }

      if (requiresAutonomousBookingRules) {
        const [propertyForRules] = await tx
          .select({ city: properties.city })
          .from(properties)
          .where(eq(properties.id, resolvedPropertyId))
          .limit(1);
        const ruleResult = validateAutonomousBookingStart({
          startAt,
          city: propertyForRules?.city ?? null,
          timezone,
          durationMinutes,
          conversationAt: autonomousConversationAt ?? now,
        });
        if (!ruleResult.ok) {
          throw new Error(ruleResult.code);
        }
      }

      if (requiresAutonomousBookingRules && bookingRules.maxJobsPerDay > 0) {
        const startLocal = DateTime.fromJSDate(startAt, {
          zone: "utc",
        }).setZone(timezone);
        const dayStartUtc = startLocal.startOf("day").toUTC().toJSDate();
        const dayEndUtc = startLocal.endOf("day").toUTC().toJSDate();
        const [dayCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(appointments)
          .where(
            and(
              gte(appointments.startAt, dayStartUtc),
              lte(appointments.startAt, dayEndUtc),
              ne(appointments.status, "canceled"),
            ),
          );
        const [holdCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(appointmentHolds)
          .where(
            and(
              gte(appointmentHolds.startAt, dayStartUtc),
              lte(appointmentHolds.startAt, dayEndUtc),
              eq(appointmentHolds.status, "active"),
              gt(appointmentHolds.expiresAt, now),
            ),
          );
        if (
          Number(dayCount?.count ?? 0) + Number(holdCount?.count ?? 0) >=
          bookingRules.maxJobsPerDay
        ) {
          throw new Error("day_full");
        }
      }

      const scheduleDecision = await inspectScheduleConflicts(tx, {
        startAt,
        durationMinutes,
        capacity: getAppointmentCapacity(),
        excludeHoldInstantQuoteId: instantQuoteId,
        now,
      });
      const scheduleOverride = decideScheduleConflictOverride(
        scheduleDecision,
        {
          reason: conflictOverrideReason,
          acknowledgement: conflictAcknowledgement,
          fingerprint: conflictFingerprint,
        },
      );
      if (!scheduleOverride.ok) {
        throw new BookingScheduleConflictError(
          scheduleDecision,
          scheduleOverride.code,
          scheduleOverride.message,
        );
      }

      const token = nanoid(24);
      const appointmentStatus = requiresAutonomousBookingRules
        ? await resolveAutomaticAppointmentStatusForMedia({
            proposedStatus: "confirmed",
            quotedScopeText: null,
            contactId,
            database: tx,
            now,
          })
        : ("confirmed" as const);
      const [appointment] = await tx
        .insert(appointments)
        .values({
          contactId,
          propertyId: resolvedPropertyId,
          ...(resolvedLeadId ? { leadId: resolvedLeadId } : {}),
          type: appointmentType,
          startAt,
          durationMinutes,
          status: appointmentStatus,
          rescheduleToken: token,
          travelBufferMinutes,
          ...(bookingDetails ? { bookingDetails } : {}),
          ...(resolvedSoldByMemberId
            ? { soldByMemberId: resolvedSoldByMemberId }
            : {}),
          ...(marketingMemberId ? { marketingMemberId } : {}),
          ...(typeof quotedTotalCents === "number" &&
          Number.isFinite(quotedTotalCents)
            ? { quotedTotalCents: Math.trunc(quotedTotalCents) }
            : {}),
        })
        .returning({ id: appointments.id, updatedAt: appointments.updatedAt });

      if (!appointment) throw new Error("appointment_create_failed");
      const appointmentId = appointment.id;

      if (notes) {
        await tx.insert(appointmentNotes).values({
          appointmentId,
          body: notes,
          createdAt: now,
        });
        await tx.insert(crmTasks).values({
          contactId,
          title: "Note",
          status: "completed",
          notes,
          dueAt: null,
          assignedTo: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await tx.insert(outboxEvents).values({
        type: "estimate.requested",
        payload: {
          appointmentId,
          services,
          ...(resolvedLeadId ? { leadId: resolvedLeadId } : {}),
          ...(instantQuoteId ? { instantQuoteId } : {}),
        },
      });

      const nextStage =
        appointmentType === "in_person_quote" ? "in_person_quote" : "qualified";
      const [pipelineRow] = await tx
        .select({ stage: crmPipeline.stage })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, contactId))
        .limit(1);
      const previousStage =
        typeof pipelineRow?.stage === "string" ? pipelineRow.stage : null;
      if (
        previousStage !== "won" &&
        previousStage !== "lost" &&
        previousStage !== nextStage
      ) {
        await tx
          .insert(crmPipeline)
          .values({ contactId, stage: nextStage })
          .onConflictDoUpdate({
            target: crmPipeline.contactId,
            set: { stage: nextStage, updatedAt: now },
          });

        await tx.insert(outboxEvents).values({
          type: "pipeline.auto_stage_change",
          payload: {
            contactId,
            fromStage: previousStage,
            toStage: nextStage,
            reason: "admin.booking.created",
            meta: {
              appointmentId,
              appointmentType,
              ...(resolvedLeadId ? { leadId: resolvedLeadId } : {}),
              ...(instantQuoteId ? { instantQuoteId } : {}),
            },
          },
        });
      }

      if (createdPropertyId) {
        await insertCalendarMutationSuccessAudit(tx, {
          actor,
          action: "property.created",
          entityType: "property",
          entityId: createdPropertyId,
          requiredPermissions: ["bookings.manage"],
          correlationId,
          committedAt: now,
          meta: { contactId, placeholder: true, source },
        });
      }
      await insertCalendarMutationSuccessAudit(tx, {
        actor,
        action: "appointment.booked",
        entityType: "appointment",
        entityId: appointmentId,
        requiredPermissions: [
          "bookings.manage",
          ...(scheduleOverride.overridden
            ? ["appointments.override_conflicts"]
            : []),
        ],
        correlationId,
        committedAt: now,
        meta: {
          contactId,
          propertyId: resolvedPropertyId,
          leadId: resolvedLeadId,
          instantQuoteId,
          startAt: startAt.toISOString(),
          durationMinutes,
          travelBufferMinutes,
          services,
          quotedTotalCents,
          bookingDetails,
          notesProvided: Boolean(notes),
          source,
          autonomousBookingRulesApplied: requiresAutonomousBookingRules,
          soldByMemberId: resolvedSoldByMemberId ?? null,
          marketingMemberId: marketingMemberId ?? null,
          soldByOverrideUsed: soldByChangeRequiresOverride({
            nextSoldByMemberId: resolvedSoldByMemberId ?? null,
            assignedSalespersonMemberId: assignedAssociateMemberId,
          }),
          scheduleConflictOverridden: scheduleOverride.overridden,
          scheduleConflictOverrideReason: scheduleOverride.reason,
          scheduleConflictFingerprint: scheduleDecision.fingerprint,
        },
      });

      return {
        appointmentId,
        version: appointment.updatedAt.toISOString(),
        leadId: resolvedLeadId,
        instantQuoteId,
        createdPropertyId,
        propertyId: resolvedPropertyId,
        soldByMemberId: resolvedSoldByMemberId,
        marketingMemberId,
        source,
        scheduleConflictOverridden: scheduleOverride.overridden,
        scheduleConflictOverrideReason: scheduleOverride.reason,
        scheduleConflictFingerprint: scheduleDecision.fingerprint,
      };
    });

    return NextResponse.json({
      ok: true,
      appointmentId: result.appointmentId,
      version: result.version,
      propertyId: result.propertyId,
      leadId: result.leadId,
      instantQuoteId: result.instantQuoteId,
      createdPlaceholderProperty: Boolean(result.createdPropertyId),
      startAt: startAt.toISOString(),
      scheduleConflictOverridden: result.scheduleConflictOverridden,
    });
  } catch (error) {
    if (error instanceof BookingScheduleConflictError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.code,
          code: error.code,
          message: error.message,
          retryable: false,
          conflictFingerprint: error.decision.fingerprint,
          conflicts: error.decision.conflicts,
          requiredAcknowledgement: error.decision.requiredAcknowledgement,
          capacity: error.decision.capacity,
        },
        {
          status:
            error.code === "schedule_conflict_override_reason_required"
              ? 422
              : 409,
        },
      );
    }
    if (error instanceof InstantQuoteHandoffFailure) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : "booking_failed";
    if (message === "instant_quote_already_booked") {
      return NextResponse.json(
        {
          error: message,
          message:
            "This instant quote already has an active appointment. Open the customer record instead of booking it twice.",
        },
        { status: 409 },
      );
    }
    if (message === "day_full") {
      return NextResponse.json(
        {
          error: "day_full",
          message:
            "That Eastern calendar day has reached the configured job limit. Choose another time.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: message },
      { status: message === "sold_by_override_code_required" ? 403 : 500 },
    );
  }
}
