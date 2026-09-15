import { createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  contacts,
  leads,
  outboxEvents,
  type DatabaseClient,
} from "@/db";
import { serviceWorkAppointmentTypePredicate } from "./appointment-kind";
import type { OpenAiAdsEvent, OpenAiAdsUser } from "./openai-ads";

const opaqueIdentifier = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\p{Cc}]+$/u);
export const OpenAiAdsAttributionSchema = z
  .object({
    consent: z.boolean(),
    consentId: z.string().uuid().optional(),
    oppref: opaqueIdentifier.optional(),
    obref: opaqueIdentifier.optional(),
    sourceUrl: z.string().url().max(2048).optional(),
    capturedAt: z.string().datetime().optional(),
  })
  .strict();

export type OpenAiAdsAttribution = z.infer<typeof OpenAiAdsAttributionSchema>;
type CaptureDatabase = Pick<DatabaseClient, "select" | "insert">;
const ATTRIBUTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    // Neither contact details nor quote/access tokens belong in ad event URLs.
    url.search = "";
    url.hash = "";
    if (
      /^\/(?:quote|quotes|partners|team|mobile|portal)(?:\/|$)/u.test(
        url.pathname,
      )
    )
      url.pathname = "/";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Preserve an explicit denial, including when a later booking has older attribution. */
export function captureOpenAiAdsAttribution(
  value: unknown,
  now = new Date(),
): OpenAiAdsAttribution | undefined {
  const parsed = OpenAiAdsAttributionSchema.safeParse(value);
  if (!parsed.success) {
    // Invalid optional tracking must not block a booking or resurrect older
    // consent from a linked lead. Treat a supplied invalid value as denied.
    return value === undefined
      ? undefined
      : { consent: false, capturedAt: now.toISOString() };
  }
  if (!parsed.data.consent)
    return { consent: false, capturedAt: now.toISOString() };
  const capturedAt = parsed.data.capturedAt
    ? new Date(parsed.data.capturedAt)
    : now;
  const age = now.getTime() - capturedAt.getTime();
  if (age < -10 * 60 * 1000 || age > ATTRIBUTION_MAX_AGE_MS) return undefined;
  return {
    consent: true,
    ...(parsed.data.consentId ? { consentId: parsed.data.consentId } : {}),
    ...(parsed.data.oppref ? { oppref: parsed.data.oppref } : {}),
    ...(parsed.data.obref ? { obref: parsed.data.obref } : {}),
    ...(sourceUrl(parsed.data.sourceUrl)
      ? { sourceUrl: sourceUrl(parsed.data.sourceUrl) }
      : {}),
    capturedAt: capturedAt.toISOString(),
  };
}

export function openAiAdsAttributionFromForm(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)["openaiAds"]
    : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A primary-key conflict makes repeated webhooks and status transitions harmless. */
export function openAiAdsOutboxId(eventId: string): string {
  const digest = hash(`stonegate:openai-ads:${eventId}`).slice(0, 32).split("");
  digest[12] = "4";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildOpenAiAdsUser(input: {
  obref?: string;
  phone?: string | null;
  email?: string | null;
}): OpenAiAdsUser {
  const user: OpenAiAdsUser = {};
  if (input.obref) user.obref = input.obref;
  const phone = input.phone
    ?.replace(/[\s().-]/gu, "")
    .replace(/^\+/, "")
    .replace(/^0+/, "");
  if (phone && /^\d{8,15}$/u.test(phone))
    user.phone_numbers_sha256 = [hash(phone)];
  const email = input.email?.trim().toLowerCase();
  if (email) user.emails_sha256 = [hash(email)];
  return user;
}

export async function enqueueOpenAiAdsEvent(
  database: CaptureDatabase,
  event: OpenAiAdsEvent,
  context: {
    contactId: string;
    consentId: string;
    appointmentId?: string;
    callSid?: string;
  },
): Promise<void> {
  await database
    .insert(outboxEvents)
    .values({
      id: openAiAdsOutboxId(event.id),
      type: "ads.openai.conversion",
      payload: { event, ...context },
      createdAt: new Date(event.timestamp_ms),
    })
    .onConflictDoNothing({ target: outboxEvents.id });
}

async function attributionForContact(
  database: CaptureDatabase,
  contactId: string,
): Promise<unknown> {
  // Look at the latest measurement decision, including denials. Never skip a
  // denial to recover an earlier opted-in lead for the same phone number.
  const [lead] = await database
    .select({ formPayload: leads.formPayload })
    .from(leads)
    .where(
      and(
        eq(leads.contactId, contactId),
        sql`${leads.formPayload} ? 'openaiAds'`,
      ),
    )
    .orderBy(
      desc(sql`${leads.formPayload}->'openaiAds'->>'capturedAt'`),
      desc(leads.createdAt),
    )
    .limit(1);
  return openAiAdsAttributionFromForm(lead?.formPayload);
}

/** Associate a manual booking only with a recent, unconverted lead at this property. */
export async function findOpenAiAdsBookingLead(
  database: CaptureDatabase,
  input: {
    existingLeadId?: string | null;
    contactId: string;
    propertyId: string;
    now: Date;
  },
): Promise<string | null> {
  if (input.existingLeadId) return input.existingLeadId;
  const recentAfter = new Date(input.now.getTime() - ATTRIBUTION_MAX_AGE_MS);
  const candidates = await database
    .select({
      id: leads.id,
      contactId: leads.contactId,
      propertyId: leads.propertyId,
      createdAt: leads.createdAt,
      formPayload: leads.formPayload,
      hasServiceBooking: sql<boolean>`exists (select 1 from ${appointments} where ${appointments.leadId} = ${leads.id} and ${appointments.status} <> 'canceled' and ${serviceWorkAppointmentTypePredicate(appointments.type)})`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.contactId, input.contactId),
        eq(leads.propertyId, input.propertyId),
        gte(leads.createdAt, recentAfter),
      ),
    )
    .orderBy(desc(leads.createdAt))
    .for("update")
    .limit(20);
  for (const candidate of candidates) {
    if (
      candidate.hasServiceBooking ||
      candidate.contactId !== input.contactId ||
      candidate.propertyId !== input.propertyId ||
      candidate.createdAt < recentAfter
    )
      continue;
    const attribution = captureOpenAiAdsAttribution(
      openAiAdsAttributionFromForm(candidate.formPayload),
      input.now,
    );
    if (attribution?.consent && attribution.consentId) return candidate.id;
  }
  return null;
}

export async function enqueueOpenAiAdsBooking(
  database: CaptureDatabase,
  input: {
    appointmentId: string;
    status: string;
    startAt: Date | null;
    contactId: string;
    leadId?: string | null;
    attribution?: unknown;
    now?: Date;
  },
): Promise<boolean> {
  if (input.status !== "confirmed" || !input.startAt) return false;
  const now = input.now ?? new Date();
  let rawAttribution = input.attribution;
  if (rawAttribution === undefined && input.leadId) {
    const [lead] = await database
      .select({ formPayload: leads.formPayload })
      .from(leads)
      .where(
        and(eq(leads.id, input.leadId), eq(leads.contactId, input.contactId)),
      )
      .limit(1);
    rawAttribution = openAiAdsAttributionFromForm(lead?.formPayload);
  }
  const attribution = captureOpenAiAdsAttribution(rawAttribution, now);
  if (!attribution?.consent || !attribution.consentId) return false;
  const latestDecision = OpenAiAdsAttributionSchema.safeParse(
    await attributionForContact(database, input.contactId),
  );
  if (latestDecision.success && !latestDecision.data.consent) {
    const deniedAt = latestDecision.data.capturedAt
      ? new Date(latestDecision.data.capturedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (deniedAt >= new Date(attribution.capturedAt!).getTime()) return false;
  }
  const [contact] = await database
    .select({ phone: contacts.phoneE164, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  const url = sourceUrl(
    attribution.sourceUrl ??
      process.env["NEXT_PUBLIC_SITE_URL"] ??
      process.env["SITE_URL"],
  );
  if (!url) return false;
  await enqueueOpenAiAdsEvent(
    database,
    {
      id: `booking:${input.appointmentId}`,
      type: "appointment_scheduled",
      timestamp_ms: now.getTime(),
      action_source: "web",
      source_url: url,
      ...(attribution.oppref ? { oppref: attribution.oppref } : {}),
      user: buildOpenAiAdsUser({
        obref: attribution.obref,
        phone: contact?.phone,
        email: contact?.email,
      }),
      data: { type: "customer_action" },
    },
    {
      contactId: input.contactId,
      appointmentId: input.appointmentId,
      consentId: attribution.consentId,
    },
  );
  return true;
}

export function isOpenAiAdsPhoneInquiry(input: {
  direction: string | null;
  status: string | null;
  duration: number | null;
  answeredBy?: string | null;
  dialCallStatus?: string | null;
  dialCallDuration?: number | null;
  dialBridged?: boolean | null;
}): boolean {
  const configured = Number(
    process.env["OPENAI_ADS_PHONE_MIN_DURATION_SECONDS"] ?? "30",
  );
  const minimum =
    Number.isSafeInteger(configured) && configured >= 1 ? configured : 30;
  const answer = input.answeredBy?.toLowerCase();
  // A completed parent includes IVR and voicemail time. Require a connected
  // dial leg or an explicit human answer before treating it as an inquiry.
  const connectedDuration =
    input.dialCallStatus === "completed" && input.dialBridged !== false
      ? input.dialCallDuration
      : answer === "human"
        ? input.duration
        : null;
  return (
    input.direction === "inbound" &&
    input.status === "completed" &&
    (connectedDuration ?? 0) >= minimum &&
    !answer?.includes("machine") &&
    answer !== "fax" &&
    answer !== "voicemail"
  );
}

export async function enqueueOpenAiAdsPhoneInquiry(
  database: CaptureDatabase,
  input: {
    callSid: string;
    parentCallSid?: string | null;
    contactId: string | null;
    phone: string | null;
    direction: string | null;
    status: string | null;
    duration: number | null;
    answeredBy?: string | null;
    dialCallStatus?: string | null;
    dialCallDuration?: number | null;
    dialBridged?: boolean | null;
    now?: Date;
  },
): Promise<"queued" | "not_qualified" | "no_measurement_context"> {
  if (!isOpenAiAdsPhoneInquiry(input)) return "not_qualified";
  if (!input.contactId) return "no_measurement_context";
  const now = input.now ?? new Date();
  const attribution = captureOpenAiAdsAttribution(
    await attributionForContact(database, input.contactId),
    now,
  );
  if (!attribution?.consent || !attribution.consentId)
    return "no_measurement_context";
  await enqueueOpenAiAdsEvent(
    database,
    {
      id: `phone:${input.parentCallSid || input.callSid}`,
      type: "lead_created",
      timestamp_ms: now.getTime(),
      action_source: "phone_call",
      ...(attribution.oppref ? { oppref: attribution.oppref } : {}),
      user: buildOpenAiAdsUser({
        obref: attribution.obref,
        phone: input.phone,
      }),
      data: { type: "customer_action" },
    },
    {
      contactId: input.contactId,
      consentId: attribution.consentId,
      callSid: input.parentCallSid || input.callSid,
    },
  );
  return "queued";
}
