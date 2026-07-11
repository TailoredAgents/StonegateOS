import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, gte, lte, ne, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointmentNotes,
  appointments,
  contacts,
  crmPipeline,
  crmTasks,
  getDb,
  outboxEvents,
  properties,
  teamMembers,
} from "@/db";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getBusinessHoursPolicy, getBookingRulesPolicy } from "@/lib/policy";
import { getAutonomousBookingDurationMinutes, validateAutonomousBookingStart } from "@/lib/after-hours-autonomy";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import {
  isValidSoldByOverrideCode,
  normalizeSoldByMemberId,
  soldByChangeRequiresOverride,
} from "@/lib/sold-by-override";
import { isAdminRequest } from "../../../web/admin";

function parseStartAt(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  const hasTimezone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
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
};

const PLACEHOLDER_CITY = "Unknown";
const PLACEHOLDER_STATE = "NA";
const PLACEHOLDER_POSTAL_CODE = "00000";

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
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
      durationMinutes: durationValue
        ? Number(durationValue)
        : undefined,
      travelBufferMinutes: travelBufferValue
        ? Number(travelBufferValue)
        : undefined,
      quotedTotalCents: quotedTotalValue
        ? Number(quotedTotalValue)
        : undefined,
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
  const soldByMemberId =
    normalizeSoldByMemberId(payload.soldByMemberId);
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
    typeof payload.autonomousConversationAt === "string" && payload.autonomousConversationAt.trim().length > 0
      ? payload.autonomousConversationAt.trim()
      : null;

  if (!contactId || !startAtIso) {
    return NextResponse.json(
      { error: "contact_and_start_required" },
      { status: 400 },
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
    return NextResponse.json({ error: "invalid_startAt" }, { status: 400 });
  }
  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      let resolvedPropertyId = propertyId;
      let createdPropertyId: string | null = null;
      let resolvedSoldByMemberId = soldByMemberId;
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
          .where(eq(properties.contactId, contactId))
          .orderBy(desc(properties.createdAt))
          .limit(1);

        if (existing?.id) {
          resolvedPropertyId = existing.id;
        } else {
          const short = contactId.split("-")[0] ?? contactId.slice(0, 8);
          const placeholderId = nanoid(6);
          const [created] = await tx
            .insert(properties)
            .values({
              contactId,
              addressLine1: `[Manual booking ${short}] Address pending (${placeholderId})`,
              addressLine2: null,
              city: PLACEHOLDER_CITY,
              state: PLACEHOLDER_STATE,
              postalCode: PLACEHOLDER_POSTAL_CODE,
              gated: false,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: properties.id });
          createdPropertyId = created?.id ?? null;
          resolvedPropertyId = createdPropertyId;
        }
      }

      if (!resolvedPropertyId) {
        throw new Error("property_create_failed");
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
        const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(timezone);
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
        if (Number(dayCount?.count ?? 0) + Number(holdCount?.count ?? 0) >= bookingRules.maxJobsPerDay) {
          throw new Error("day_full");
        }
      }

      if (requiresAutonomousBookingRules) {
        const capacity = getAppointmentCapacity();
        const slotEnd = new Date(startAt.getTime() + (durationMinutes + travelBufferMinutes) * 60_000);
        const blockStart = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
        const blockEnd = new Date(slotEnd.getTime() + 24 * 60 * 60 * 1000);
        const [appointmentBlocks, holdBlocks] = await Promise.all([
          tx
            .select({
              startAt: appointments.startAt,
              durationMinutes: appointments.durationMinutes,
              travelBufferMinutes: appointments.travelBufferMinutes,
            })
            .from(appointments)
            .where(and(gte(appointments.startAt, blockStart), lte(appointments.startAt, blockEnd), ne(appointments.status, "canceled"))),
          tx
            .select({
              startAt: appointmentHolds.startAt,
              durationMinutes: appointmentHolds.durationMinutes,
              travelBufferMinutes: appointmentHolds.travelBufferMinutes,
            })
            .from(appointmentHolds)
            .where(and(gte(appointmentHolds.startAt, blockStart), lte(appointmentHolds.startAt, blockEnd), eq(appointmentHolds.status, "active"), gt(appointmentHolds.expiresAt, now))),
        ]);
        const overlapCount = [...appointmentBlocks, ...holdBlocks].reduce((count, block) => {
          const blockStartAt = block.startAt;
          if (!(blockStartAt instanceof Date)) return count;
          const blockEndAt = new Date(
            blockStartAt.getTime() + ((block.durationMinutes ?? durationMinutes) + (block.travelBufferMinutes ?? travelBufferMinutes)) * 60_000,
          );
          return overlaps(startAt, slotEnd, blockStartAt, blockEndAt) ? count + 1 : count;
        }, 0);
        if (overlapCount >= capacity) {
          throw new Error("slot_full");
        }
      }

      const token = nanoid(24);
      const [appointment] = await tx
        .insert(appointments)
        .values({
          contactId,
          propertyId: resolvedPropertyId,
          type: appointmentType,
          startAt,
          durationMinutes,
          status: "confirmed",
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
        .returning({ id: appointments.id });

      const appointmentId = appointment?.id ?? null;
      if (!appointmentId) throw new Error("appointment_create_failed");

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
            },
          },
        });
      }

      return {
        appointmentId,
        createdPropertyId,
        propertyId: resolvedPropertyId,
        soldByMemberId: resolvedSoldByMemberId,
        marketingMemberId,
        source,
      };
    });

    if (result.createdPropertyId) {
      await recordAuditEvent({
        actor,
        action: "property.created",
        entityType: "property",
        entityId: result.createdPropertyId,
        meta: { contactId, placeholder: true, source: result.source },
      });
    }

    await recordAuditEvent({
      actor,
      action: "appointment.booked",
      entityType: "appointment",
      entityId: result.appointmentId,
      meta: {
        contactId,
        propertyId: result.propertyId,
        startAt: startAt.toISOString(),
        durationMinutes,
        travelBufferMinutes,
        services,
        quotedTotalCents,
        bookingDetails,
        notesProvided: Boolean(notes),
        source: result.source,
        autonomousBookingRulesApplied: requiresAutonomousBookingRules,
        soldByMemberId: result.soldByMemberId ?? null,
        marketingMemberId: result.marketingMemberId ?? null,
        soldByOverrideUsed: soldByChangeRequiresOverride({
          nextSoldByMemberId: result.soldByMemberId ?? null,
          assignedSalespersonMemberId: assignedAssociateMemberId,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      appointmentId: result.appointmentId,
      propertyId: result.propertyId,
      createdPlaceholderProperty: Boolean(result.createdPropertyId),
      startAt: startAt.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "booking_failed";
    return NextResponse.json(
      { error: message },
      { status: message === "sold_by_override_code_required" ? 403 : 500 },
    );
  }
}
