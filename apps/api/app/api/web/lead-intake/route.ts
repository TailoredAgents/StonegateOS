import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb, leads, outboxEvents, appointments } from "@/db";
import { sendConversion } from "@/lib/ga";
import { getOutOfAreaMessage, getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";
import { normalizeName, normalizePhone, resolveClientIp } from "../utils";
import { upsertContact, upsertProperty } from "../persistence";
import { DEFAULT_TRAVEL_BUFFER_MIN, resolveAppointmentTiming } from "../scheduling";

const rateLimiter = new LRUCache<string, { count: number }>({
  max: 500,
  ttl: 60_000
});

const ALLOWED_ORIGIN =
  process.env["NEXT_PUBLIC_SITE_URL"] ??
  process.env["SITE_URL"] ??
  "*";

function applyCors(response: NextResponse, origin = ALLOWED_ORIGIN): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init));
}

export function OPTIONS(): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }));
}

const LeadSchema = z.object({
  services: z.array(z.string().min(2)).nonempty().optional(),
  service: z.string().min(2).optional(),
  name: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional(),
  addressLine1: z.string().min(5),
  city: z.string().min(2),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3),
  notes: z.string().max(1000).optional(),
  scheduling: z
    .object({
      preferredDate: z.string().optional(),
      alternateDate: z.string().optional(),
      timeWindow: z.string().optional()
    })
    .optional(),
  appointmentType: z.enum(["in_person_estimate", "web_lead"]).optional(),
  utm: z
    .object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      term: z.string().optional(),
      content: z.string().optional(),
      gclid: z.string().optional(),
      fbclid: z.string().optional()
    })
    .optional(),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),
  consent: z.boolean().optional(),
  hp_company: z.string().optional()
});

function checkRateLimit(key: string): boolean {
  // Disable rate limiting in E2E test environment to allow parallel test execution
  if (process.env["NODE_ENV"] === "test" || process.env["E2E_RUN_ID"]) {
    return false;
  }

  if (key === "unknown") {
    return false;
  }

  const existing = rateLimiter.get(key);
  if (existing && existing.count >= 3) {
    return true;
  }

  if (existing) {
    existing.count += 1;
    rateLimiter.set(key, existing, { ttl: 60_000 });
  } else {
    rateLimiter.set(key, { count: 1 });
  }

  return false;
}

export async function POST(request: NextRequest) {
  const ip = resolveClientIp(request);

  if (checkRateLimit(ip)) {
    return corsJson({ error: "rate_limited" }, { status: 429 });
  }

  const db = getDb();

  const body: unknown = await request.json();
  const parsedPayload = LeadSchema.safeParse(body);

  if (!parsedPayload.success) {
    return corsJson(
      { error: "invalid_payload", message: parsedPayload.error.message },
      { status: 400 }
    );
  }

  const payload = parsedPayload.data;

  if (payload.hp_company && payload.hp_company.trim().length > 0) {
    return corsJson({ ok: true });
  }

  const servicesRequested = payload.services ?? (payload.service ? [payload.service] : []);
  if (!servicesRequested.length) {
    return corsJson(
      { error: "invalid_payload", message: "At least one service must be selected." },
      { status: 400 }
    );
  }

  const appointmentType = payload.appointmentType ?? "web_lead";
  const scheduling = payload.scheduling ?? {};
  const timing = resolveAppointmentTiming(scheduling.preferredDate ?? null, scheduling.timeWindow ?? null);
  const travelBufferMinutes = DEFAULT_TRAVEL_BUFFER_MIN;
  const rescheduleToken = appointmentType === "in_person_estimate" ? nanoid(24) : null;

  let normalizedPhone: ReturnType<typeof normalizePhone>;
  try {
    normalizedPhone = normalizePhone(payload.phone);
  } catch {
    return corsJson({ error: "invalid_phone" }, { status: 400 });
  }

  const email = payload.email?.trim().toLowerCase();
  const { firstName, lastName } = normalizeName(payload.name);
  const trimmedCity = payload.city.trim();
  const normalizedState = payload.state.trim().toUpperCase();
  const addressLine1 = payload.addressLine1.trim();
  const postalCode = payload.postalCode.trim();
  const normalizedPostalCode = normalizePostalCode(postalCode);

  const serviceArea = await getServiceAreaPolicy();
  if (normalizedPostalCode && !isPostalCodeAllowed(normalizedPostalCode, serviceArea)) {
    return corsJson(
      {
        ok: false,
        error: "out_of_area",
        message: await getOutOfAreaMessage("web")
      },
      { status: 200 }
    );
  }

  const leadResult = await db.transaction(async (tx) => {
    const contact = await upsertContact(tx, {
      firstName,
      lastName,
      email,
      phoneRaw: normalizedPhone.raw,
      phoneE164: normalizedPhone.e164,
      source: "web"
    });

    const property = await upsertProperty(tx, {
      contactId: contact.id,
      addressLine1,
      city: trimmedCity,
      state: normalizedState,
      postalCode,
      gated: false
    });

    const utm = payload.utm ?? {};

    const [lead] = await tx
      .insert(leads)
      .values({
        contactId: contact.id,
        propertyId: property.id,
        servicesRequested,
        notes: payload.notes,
        status: appointmentType === "in_person_estimate" ? "scheduled" : "new",
        source: "web",
        utmSource: utm.source,
        utmMedium: utm.medium,
        utmCampaign: utm.campaign,
        utmTerm: utm.term,
        utmContent: utm.content,
        gclid: payload.gclid ?? utm.gclid,
        fbclid: payload.fbclid ?? utm.fbclid,
        referrer: request.headers.get("referer") ?? undefined,
        formPayload: {
          services: servicesRequested,
          appointmentType,
          scheduling,
          addressLine1,
          city: trimmedCity,
          state: normalizedState,
          postalCode,
          notes: payload.notes,
          utm
        }
      })
      .returning({
        id: leads.id,
        status: leads.status
      });

    if (!lead) {
      throw new Error("Failed to record lead");
    }

    let appointmentRecord:
      | {
          id: string;
          startAt: Date | null;
          durationMinutes: number;
          travelBufferMinutes: number;
          rescheduleToken: string;
          calendarEventId: string | null;
        }
      | null = null;

    if (appointmentType === "in_person_estimate") {
      const [appt] = await tx
        .insert(appointments)
        .values({
          contactId: contact.id,
          propertyId: property.id,
          leadId: lead.id,
          type: "estimate",
          startAt: timing.startAt,
          durationMinutes: timing.durationMinutes,
          travelBufferMinutes,
          status: "requested",
          rescheduleToken: rescheduleToken ?? nanoid(12)
        })
        .returning({
          id: appointments.id,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          travelBufferMinutes: appointments.travelBufferMinutes,
          rescheduleToken: appointments.rescheduleToken,
          calendarEventId: appointments.calendarEventId
        });

      appointmentRecord = appt ?? null;
    }

    const eventType = appointmentType === "in_person_estimate" ? "estimate.requested" : "lead.created";
    await tx.insert(outboxEvents).values({
      type: eventType,
      payload: {
        leadId: lead.id,
        services: servicesRequested,
        appointmentType,
        scheduling,
        source: "web",
        appointmentId: appointmentRecord?.id ?? null
      }
    });

    return {
      leadId: lead.id,
      contactId: contact.id,
      propertyId: property.id,
      appointment: appointmentRecord
    };
  });

  console.info("[lead-intake] new lead", {
    leadId: leadResult.leadId,
    services: servicesRequested,
    appointmentType,
    scheduling,
    ip
  });

  void sendConversion("generate_lead", {
    params: {
      source: payload.utm?.source ?? "web",
      medium: payload.utm?.medium ?? "form",
      campaign: payload.utm?.campaign,
      service: servicesRequested[0],
      appointment_id: leadResult.appointment?.id
    }
  });

  // TEMPORARY FIX: Calendar event creation moved to background job to prevent request timeouts
  // TODO: Implement proper background job queue for calendar event creation
  if (appointmentType === "in_person_estimate") {
    const appointment = leadResult.appointment;
    if (appointment) {
      console.info("[lead-intake] appointment_scheduled", {
        appointmentId: appointment.id,
        leadId: leadResult.leadId,
        note: "Calendar event creation will be handled by background job processor"
      });
    }
  }

  return corsJson({
    ok: true,
    leadId: leadResult.leadId,
    appointmentId: leadResult.appointment?.id ?? null,
    rescheduleToken: leadResult.appointment?.rescheduleToken ?? null,
    startAt: leadResult.appointment?.startAt?.toISOString() ?? null,
    durationMinutes: leadResult.appointment?.durationMinutes ?? null,
    travelBufferMinutes: leadResult.appointment?.travelBufferMinutes ?? null,
    timeWindow: scheduling.timeWindow ?? null,
    preferredDate: scheduling.preferredDate ?? null
  });
}
