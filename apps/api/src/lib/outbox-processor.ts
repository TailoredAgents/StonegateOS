import { and, asc, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import crypto from "node:crypto";
import {
  getDb,
  outboxEvents,
  appointments,
  automationSettings,
  leads,
  contacts,
  crmTasks,
  policySettings,
  properties,
  quotes,
  crmPipeline,
  conversationParticipants,
  conversationMessages,
  conversationThreads,
  leadAutomationStates,
  messageDeliveryEvents
} from "@/db";
import {
  getBusinessHoursPolicy,
  getConfirmationLoopPolicy,
  getFollowUpSequencePolicy,
  getQuietHoursPolicy,
  getTemplatesPolicy,
  nextQuietHoursEnd,
  resolveTemplateForChannel
} from "@/lib/policy";
import type { EstimateNotificationPayload, QuoteNotificationPayload } from "@/lib/notifications";
import {
  sendEstimateConfirmation,
  sendEstimateReminder,
  sendQuoteSentNotification,
  sendQuoteDecisionNotification
} from "@/lib/notifications";
import type { AppointmentCalendarPayload } from "@/lib/calendar";
import { createCalendarEventWithRetry, updateCalendarEventWithRetry } from "@/lib/calendar-events";
import { sendDmMessage, sendDmTyping, sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import { handleInboundAutoReply } from "@/lib/auto-replies";
import { recordAuditEvent } from "@/lib/audit";
import { recordProviderFailure, recordProviderSuccess } from "@/lib/provider-health";
import { MetaGraphApiError, syncMetaAdsInsightsDaily } from "@/lib/meta-ads-insights";

type OutboxEventRecord = typeof outboxEvents.$inferSelect;

export interface OutboxBatchStats {
  total: number;
  processed: number;
  skipped: number;
  errors: number;
}

export interface ProcessOutboxBatchOptions {
  limit?: number;
}

type OutboxOutcome = {
  status: "processed" | "skipped" | "retry";
  error?: string | null;
  nextAttemptAt?: Date | null;
};

const MAX_MESSAGE_SEND_ATTEMPTS = 3;
const MESSAGE_SEND_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const HUMANISTIC_DELAY_MIN_MS = 10_000;
const HUMANISTIC_DELAY_MAX_MS = 30_000;

const APPOINTMENT_STATUS_VALUES = ["requested", "confirmed", "completed", "no_show", "canceled"] as const;
type AppointmentStatus = (typeof APPOINTMENT_STATUS_VALUES)[number];
const VALID_APPOINTMENT_STATUSES = new Set<string>(APPOINTMENT_STATUS_VALUES);

type PipelineStage = "new" | "contacted" | "qualified" | "quoted" | "won" | "lost";
const PIPELINE_STAGE_SET = new Set<PipelineStage>(["new", "contacted", "qualified", "quoted", "won", "lost"]);

type FollowUpChannel = "sms" | "email";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === "string" && VALID_APPOINTMENT_STATUSES.has(value);
}

function getRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return MESSAGE_SEND_RETRY_DELAYS_MS[0] ?? 60_000;
  }
  const index = Math.min(attempt - 1, MESSAGE_SEND_RETRY_DELAYS_MS.length - 1);
  return MESSAGE_SEND_RETRY_DELAYS_MS[index] ?? MESSAGE_SEND_RETRY_DELAYS_MS[0] ?? 60_000;
}

function parseSmsFailureStatus(detail: string): number | null {
  if (!detail.startsWith("sms_failed:")) {
    return null;
  }
  const parts = detail.split(":");
  if (parts.length < 2) {
    return null;
  }
  const status = Number(parts[1]);
  return Number.isFinite(status) ? status : null;
}

function isRetryableSendFailure(detail: string | null): boolean {
  if (!detail) {
    return true;
  }
  const normalized = detail.toLowerCase();
  if (
    normalized.includes("not_configured") ||
    normalized.includes("missing_recipient") ||
    normalized.includes("unsupported_channel")
  ) {
    return false;
  }
  if (normalized.startsWith("sms_failed:")) {
    const status = parseSmsFailureStatus(normalized);
    if (typeof status === "number" && status >= 400 && status < 500) {
      return false;
    }
  }
  return true;
}

async function recordProviderSuccessSafe(provider: "sms" | "email" | "calendar" | "meta_ads"): Promise<void> {
  try {
    await recordProviderSuccess(provider);
  } catch (error) {
    console.warn("[provider] health_success_failed", { provider, error: String(error) });
  }
}

async function recordProviderFailureSafe(
  provider: "sms" | "email" | "calendar" | "meta_ads",
  detail: string | null
): Promise<void> {
  try {
    await recordProviderFailure(provider, detail ?? null);
  } catch (error) {
    console.warn("[provider] health_failure_failed", { provider, error: String(error) });
  }
}

function coerceServices(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function randomHumanisticDelayMs(): number {
  return Math.floor(Math.random() * (HUMANISTIC_DELAY_MAX_MS - HUMANISTIC_DELAY_MIN_MS + 1)) + HUMANISTIC_DELAY_MIN_MS;
}

function readMetaNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  return readStringValue(metadata[key]);
}

function resolveDmProvider(metadata: Record<string, unknown> | null): string | null {
  return (
    readMetadataString(metadata, "dmProvider") ??
    readMetadataString(metadata, "source") ??
    readMetadataString(metadata, "provider") ??
    null
  );
}

function resolveDmPageId(metadata: Record<string, unknown> | null): string | null {
  return (
    readMetadataString(metadata, "dmPageId") ??
    readMetadataString(metadata, "pageId") ??
    readMetadataString(metadata, "recipientId") ??
    readMetadataString(metadata, "page_id") ??
    null
  );
}

function mergeMetadata(
  existing: Record<string, unknown> | null,
  updates: Record<string, unknown>
): Record<string, unknown> {
  return { ...(existing ?? {}), ...updates };
}

function isDmWebhookConfigured(): boolean {
  return Boolean(readStringValue(process.env["DM_WEBHOOK_URL"]));
}

function hasFacebookDmEnv(): boolean {
  return Boolean(
    readStringValue(process.env["FB_MESSENGER_ACCESS_TOKEN"]) ?? readStringValue(process.env["FB_LEADGEN_ACCESS_TOKEN"])
  );
}

async function resolveDmSendMetadata(
  db: ReturnType<typeof getDb>,
  threadId: string,
  metadata: Record<string, unknown> | null
): Promise<Record<string, unknown> | null> {
  const provider = resolveDmProvider(metadata);
  const pageId = resolveDmPageId(metadata) ?? readStringValue(process.env["FB_PAGE_ID"]);

  if (provider && pageId) {
    return metadata;
  }

  const [latestInbound] = await db
    .select({
      provider: conversationMessages.provider,
      toAddress: conversationMessages.toAddress,
      metadata: conversationMessages.metadata,
      receivedAt: conversationMessages.receivedAt,
      createdAt: conversationMessages.createdAt
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, threadId),
        eq(conversationMessages.channel, "dm"),
        eq(conversationMessages.direction, "inbound")
      )
    )
    .orderBy(desc(conversationMessages.receivedAt), desc(conversationMessages.createdAt))
    .limit(1);

  const inboundMetadata = isRecord(latestInbound?.metadata) ? latestInbound.metadata : null;
  const inferredProvider =
    provider ??
    readStringValue(latestInbound?.provider) ??
    resolveDmProvider(inboundMetadata) ??
    (!isDmWebhookConfigured() && hasFacebookDmEnv() ? "facebook" : null);
  const inferredPageId =
    pageId ??
    readStringValue(latestInbound?.toAddress) ??
    resolveDmPageId(inboundMetadata) ??
    null;

  if (!inferredProvider && !inferredPageId) {
    return metadata;
  }

  const updates: Record<string, unknown> = {};
  if (!readMetadataString(metadata, "dmProvider") && inferredProvider) {
    updates["dmProvider"] = inferredProvider;
  }
  if (!resolveDmPageId(metadata) && inferredPageId) {
    updates["dmPageId"] = inferredPageId;
  }

  return Object.keys(updates).length === 0 ? metadata : mergeMetadata(metadata, updates);
}

async function resolveDmRecipient(db: ReturnType<typeof getDb>, threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ externalAddress: conversationParticipants.externalAddress })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "contact")
      )
    )
    .limit(1);
  return typeof row?.externalAddress === "string" && row.externalAddress.trim().length > 0
    ? row.externalAddress.trim()
    : null;
}

function buildQuoteShareUrl(token: string): string {
  const base =
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    process.env["SITE_URL"] ??
    "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/quote/${token}`;
}

function buildRescheduleUrlForAppointment(appointmentId: string, token: string): string {
  const base =
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    process.env["SITE_URL"] ??
    "http://localhost:3000";
  const url = new URL("/schedule", base);
  url.searchParams.set("appointmentId", appointmentId);
  url.searchParams.set("token", token);
  return url.toString();
}

function parseLeadAlertRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readPhoneMapValue(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const phonesRaw = value["phones"];
  if (!isRecord(phonesRaw)) return {};
  const phones: Record<string, string> = {};
  for (const [key, raw] of Object.entries(phonesRaw)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      phones[key] = raw.trim();
    }
  }
  return phones;
}

async function getTeamMemberPhoneMap(db: ReturnType<typeof getDb>): Promise<Record<string, string>> {
  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, "team_member_phones"))
    .limit(1);
  return readPhoneMapValue(row?.value);
}

function formatReminderDueAt(dueAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(dueAt);
  } catch {
    return dueAt.toISOString();
  }
}

function normalizeEmailForHash(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhoneForHash(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function hashSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function buildLeadAlertMessage(leadId: string): Promise<{ text: string; phone: string | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      source: leads.source,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(properties, eq(leads.propertyId, properties.id))
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!row) return null;

  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  const phone = row.phoneE164 ?? row.phone ?? null;
  const addressParts = [row.addressLine1, row.city, row.state, row.postalCode]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  const address = addressParts.length ? addressParts.join(", ") : null;
  const source = typeof row.source === "string" && row.source.length ? row.source : null;

  const pieces = [
    name ? `New lead: ${name}` : "New lead received",
    phone ? `Phone: ${phone}` : null,
    address ? `Address: ${address}` : null,
    source ? `Source: ${source}` : null
  ].filter(Boolean);

  return {
    text: pieces.join(" | "),
    phone
  };
}

function buildCalendarPayloadFromNotification(
  notification: EstimateNotificationPayload
): AppointmentCalendarPayload | null {
  const appointment = notification.appointment;
  if (!appointment.startAt) {
    return null;
  }

  const rescheduleUrl =
    appointment.rescheduleUrl ?? buildRescheduleUrlForAppointment(appointment.id, appointment.rescheduleToken);

  return {
    appointmentId: appointment.id,
    startAt: appointment.startAt,
    durationMinutes: appointment.durationMinutes,
    travelBufferMinutes: appointment.travelBufferMinutes,
    services: notification.services,
    notes: notification.notes ?? null,
    contact: {
      name: notification.contact.name,
      email: notification.contact.email ?? null,
      phone: notification.contact.phone ?? null
    },
    property: {
      addressLine1: notification.property.addressLine1,
      city: notification.property.city,
      state: notification.property.state,
      postalCode: notification.property.postalCode
    },
    rescheduleUrl
  };
}

async function ensureCalendarEventCreated(
  notification: EstimateNotificationPayload
): Promise<string | null> {
  if (notification.appointment.calendarEventId) {
    return notification.appointment.calendarEventId;
  }

  const payload = buildCalendarPayloadFromNotification(notification);
  if (!payload) {
    return null;
  }

  const eventId = await createCalendarEventWithRetry(payload);
  if (!eventId) {
    console.warn("[calendar] create_skipped", { appointmentId: notification.appointment.id });
    return null;
  }

  try {
    const db = getDb();
    await db
      .update(appointments)
      .set({ calendarEventId: eventId, updatedAt: new Date() })
      .where(eq(appointments.id, notification.appointment.id));
  } catch (error) {
    console.warn("[calendar] appointment_update_failed", {
      appointmentId: notification.appointment.id,
      error: String(error)
    });
  }

  return eventId;
}

async function syncCalendarEventForReschedule(
  notification: EstimateNotificationPayload
): Promise<string | null> {
  const payload = buildCalendarPayloadFromNotification(notification);
  if (!payload) {
    return notification.appointment.calendarEventId ?? null;
  }

  const db = getDb();
  let calendarEventId = notification.appointment.calendarEventId ?? null;

  if (calendarEventId) {
    const updated = await updateCalendarEventWithRetry(calendarEventId, payload);
    if (updated) {
      return calendarEventId;
    }
    console.warn("[calendar] update_retry_failed", {
      appointmentId: notification.appointment.id,
      eventId: calendarEventId
    });
  }

  calendarEventId = await createCalendarEventWithRetry(payload);
  if (!calendarEventId) {
    console.warn("[calendar] create_after_update_failed", {
      appointmentId: notification.appointment.id
    });
    return null;
  }

  try {
    await db
      .update(appointments)
      .set({ calendarEventId, updatedAt: new Date() })
      .where(eq(appointments.id, notification.appointment.id));
  } catch (error) {
    console.warn("[calendar] appointment_update_failed", {
      appointmentId: notification.appointment.id,
      error: String(error)
    });
  }

  return calendarEventId;
}

async function buildNotificationPayload(
  appointmentId: string,
  overrides?: {
    services?: string[];
    rescheduleUrl?: string | null;
    scheduling?: Partial<EstimateNotificationPayload["scheduling"]>;
    notes?: string | null;
  }
): Promise<EstimateNotificationPayload | null> {
  const db = getDb();

  const rows = await db
    .select({
      appointmentId: appointments.id,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      status: appointments.status,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId,
      leadId: appointments.leadId,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      leadServices: leads.servicesRequested,
      leadNotes: leads.notes,
      leadFormPayload: leads.formPayload
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    console.warn("[outbox] appointment_not_found", { appointmentId });
    return null;
  }

  const services =
    overrides?.services && overrides.services.length > 0
      ? overrides.services
      : Array.isArray(row.leadServices)
        ? row.leadServices.filter((service): service is string => typeof service === "string" && service.length > 0)
        : [];

  const formPayload = isRecord(row.leadFormPayload) ? row.leadFormPayload : null;
  const schedulingPayload = formPayload && isRecord(formPayload["scheduling"]) ? formPayload["scheduling"] : null;

  const scheduling: EstimateNotificationPayload["scheduling"] = {
    preferredDate:
      overrides?.scheduling?.preferredDate ??
      (typeof schedulingPayload?.["preferredDate"] === "string" ? schedulingPayload["preferredDate"] : null),
    alternateDate:
      overrides?.scheduling?.alternateDate ??
      (typeof schedulingPayload?.["alternateDate"] === "string" ? schedulingPayload["alternateDate"] : null),
    timeWindow:
      overrides?.scheduling?.timeWindow ??
      (typeof schedulingPayload?.["timeWindow"] === "string" ? schedulingPayload["timeWindow"] : null)
  };

  const contactNameParts = [row.contactFirstName, row.contactLastName].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  const contactName =
    contactNameParts.join(" ").trim() ||
    row.contactFirstName ||
    row.contactLastName ||
    "Stonegate Customer";

  const status: AppointmentStatus = isValidAppointmentStatus(row.status) ? row.status : "requested";

  const rescheduleToken = row.rescheduleToken;
  if (!rescheduleToken) {
    console.warn("[outbox] missing_reschedule_token", { appointmentId });
    return null;
  }

  const rescheduleUrl =
    overrides?.rescheduleUrl ?? buildRescheduleUrlForAppointment(row.appointmentId, rescheduleToken);

  const payload: EstimateNotificationPayload = {
    leadId: row.leadId ?? "unknown",
    contactId: row.contactId ?? undefined,
    services,
    contact: {
      name: contactName,
      email: row.contactEmail ?? undefined,
      phone: row.contactPhoneE164 ?? row.contactPhone ?? undefined
    },
    property: {
      addressLine1: row.propertyAddressLine1 ?? "Undisclosed address",
      city: row.propertyCity ?? "",
      state: row.propertyState ?? "",
      postalCode: row.propertyPostalCode ?? ""
    },
    scheduling,
    appointment: {
      id: row.appointmentId,
      startAt: row.startAt ?? null,
      durationMinutes: row.durationMinutes ?? 60,
      travelBufferMinutes: row.travelBufferMinutes ?? 30,
      status,
      rescheduleToken,
      rescheduleUrl,
      calendarEventId: row.calendarEventId ?? null
    },
    notes: overrides?.notes ?? (typeof row.leadNotes === "string" ? row.leadNotes : null)
  };

  return payload;
}

async function buildQuoteNotificationPayload(
  quoteId: string,
  overrides?: {
    shareToken?: string | null;
    notes?: string | null;
  }
): Promise<QuoteNotificationPayload | null> {
  const db = getDb();

  const rows = await db
    .select({
      id: quotes.id,
      services: quotes.services,
      total: quotes.total,
      depositDue: quotes.depositDue,
      balanceDue: quotes.balanceDue,
      shareToken: quotes.shareToken,
      expiresAt: quotes.expiresAt,
      contactId: quotes.contactId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.id, quoteId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    console.warn("[outbox] quote_not_found", { quoteId });
    return null;
  }

  const services = Array.isArray(row.services)
    ? row.services.filter((service): service is string => typeof service === "string" && service.trim().length > 0)
    : [];

  const shareToken = overrides?.shareToken ?? row.shareToken ?? null;
  const shareUrl = shareToken ? buildQuoteShareUrl(shareToken) : null;
  if (!shareUrl) {
    console.warn("[outbox] quote_missing_share_url", { quoteId });
    return null;
  }

  const contactNameParts = [row.contactFirstName, row.contactLastName].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  const customerName = contactNameParts.join(" ").trim() || row.contactFirstName || "Stonegate Customer";

  const total = Number(row.total ?? 0);
  const depositDue = Number(row.depositDue ?? 0);
  const balanceDue = Number(row.balanceDue ?? 0);

  return {
    quoteId,
    services,
    contact: {
      name: customerName,
      email: row.contactEmail ?? null,
      phone: row.contactPhoneE164 ?? row.contactPhone ?? null
    },
    contactId: row.contactId ?? null,
    total,
    depositDue,
    balanceDue,
    shareUrl,
    expiresAt: row.expiresAt ?? null,
    notes: overrides?.notes ?? null
  };
}

async function updatePipelineStageForContact(
  contactId: string | null | undefined,
  targetStage: PipelineStage,
  reason: string,
  meta?: Record<string, unknown>
): Promise<void> {
  if (!contactId || !PIPELINE_STAGE_SET.has(targetStage)) {
    return;
  }

  try {
    const db = getDb();
    const [existing] = await db
      .select({ stage: crmPipeline.stage })
      .from(crmPipeline)
      .where(eq(crmPipeline.contactId, contactId))
      .limit(1);

    const previousStage = (existing?.stage ?? null) as PipelineStage | null;
    if (previousStage === targetStage) {
      return;
    }

    await db
      .insert(crmPipeline)
      .values({ contactId, stage: targetStage })
      .onConflictDoUpdate({
        target: crmPipeline.contactId,
        set: {
          stage: targetStage,
          updatedAt: new Date()
        }
      });

    await db.insert(outboxEvents).values({
      type: "pipeline.auto_stage_change",
      payload: {
        contactId,
        fromStage: previousStage,
        toStage: targetStage,
        reason,
        meta
      }
    });
  } catch (error) {
    console.warn("[pipeline] auto_update_failed", {
      contactId,
      targetStage,
      reason,
      error: String(error)
    });
  }
}

function mapAppointmentStatusToStage(status: string): PipelineStage {
  switch (status) {
    case "confirmed":
    case "requested":
      return "qualified";
    case "completed":
      return "won";
    case "no_show":
    case "canceled":
      return "lost";
    default:
      return "qualified";
  }
}

async function clearLeadFollowups(leadId: string | null | undefined): Promise<void> {
  if (!leadId) return;
  const db = getDb();
  const now = new Date();

  await db
    .update(leadAutomationStates)
    .set({
      followupState: "stopped",
      followupStep: 0,
      nextFollowupAt: null,
      updatedAt: now
    })
    .where(eq(leadAutomationStates.leadId, leadId));

  await db
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "followup.send"),
        isNull(outboxEvents.processedAt),
        sql`(payload->>'leadId') = ${leadId}`
      )
    );
}

async function getAutomationMode(
  db: ReturnType<typeof getDb>,
  channel: FollowUpChannel
): Promise<"draft" | "assist" | "auto"> {
  const [row] = await db
    .select({ mode: automationSettings.mode })
    .from(automationSettings)
    .where(eq(automationSettings.channel, channel))
    .limit(1);

  return (row?.mode ?? "draft") as "draft" | "assist" | "auto";
}

async function getLeadAutomationState(
  db: ReturnType<typeof getDb>,
  leadId: string,
  channel: FollowUpChannel
): Promise<{
  paused: boolean;
  dnc: boolean;
  humanTakeover: boolean;
  followupState: string | null;
}> {
  const [row] = await db
    .select({
      paused: leadAutomationStates.paused,
      dnc: leadAutomationStates.dnc,
      humanTakeover: leadAutomationStates.humanTakeover,
      followupState: leadAutomationStates.followupState
    })
    .from(leadAutomationStates)
    .where(and(eq(leadAutomationStates.leadId, leadId), eq(leadAutomationStates.channel, channel)))
    .limit(1);

  return (
    row ?? {
      paused: false,
      dnc: false,
      humanTakeover: false,
      followupState: null
    }
  );
}

function getContactChannelAddress(
  contact: { email?: string | null; phone?: string | null; phoneE164?: string | null },
  channel: FollowUpChannel
): string | null {
  return channel === "sms"
    ? contact.phoneE164 ?? contact.phone ?? null
    : contact.email ?? null;
}

async function resolveFollowUpChannel(
  db: ReturnType<typeof getDb>,
  leadId: string,
  contact: { email?: string | null; phone?: string | null; phoneE164?: string | null },
  preferred: FollowUpChannel[] = ["sms", "email"]
): Promise<FollowUpChannel | null> {
  for (const channel of preferred) {
    const toAddress = getContactChannelAddress(contact, channel);
    if (!toAddress) continue;

    const mode = await getAutomationMode(db, channel);
    if (mode === "draft") continue;

    const state = await getLeadAutomationState(db, leadId, channel);
    if (state.paused || state.dnc || state.humanTakeover) continue;

    return channel;
  }
  return null;
}

async function ensureThreadForLead(
  db: ReturnType<typeof getDb>,
  input: { leadId: string; contactId: string; propertyId: string | null; channel: FollowUpChannel }
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(and(eq(conversationThreads.leadId, input.leadId), eq(conversationThreads.channel, input.channel)))
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(1);

  if (existing?.id) {
    return existing.id;
  }

  const now = new Date();
  const [created] = await db
    .insert(conversationThreads)
    .values({
      leadId: input.leadId,
      contactId: input.contactId,
      propertyId: input.propertyId,
      status: "open",
      channel: input.channel,
      subject: input.channel === "email" ? "Stonegate follow-up" : null,
      lastMessagePreview: "Follow-up scheduled",
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: conversationThreads.id });

  return created?.id ?? null;
}

async function queueOutboundMessage(input: {
  db: ReturnType<typeof getDb>;
  threadId: string;
  channel: FollowUpChannel;
  body: string;
  toAddress: string;
  subject?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<string | null> {
  const now = new Date();
  const [existingParticipant] = await input.db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, input.threadId),
        eq(conversationParticipants.participantType, "system")
      )
    )
    .limit(1);

  const participantId =
    existingParticipant?.id ??
    (
      await input.db
        .insert(conversationParticipants)
        .values({
          threadId: input.threadId,
          participantType: "system",
          displayName: "Stonegate Assistant",
          createdAt: now
        })
        .returning({ id: conversationParticipants.id })
    )[0]?.id ??
    null;

  const [message] = await input.db
    .insert(conversationMessages)
    .values({
      threadId: input.threadId,
      participantId,
      direction: "outbound",
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      toAddress: input.toAddress,
      deliveryStatus: "queued",
      metadata: input.metadata ?? null,
      createdAt: now
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) {
    return null;
  }

  await input.db
    .update(conversationThreads)
    .set({
      lastMessagePreview: input.body.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now
    })
    .where(eq(conversationThreads.id, input.threadId));

  await input.db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: now
  });

  return message.id;
}

async function scheduleLeadFollowups(leadId: string, contactId: string): Promise<void> {
  const db = getDb();
  const followupPolicy = await getFollowUpSequencePolicy(db);
  if (!followupPolicy.enabled) {
    return;
  }

  await clearLeadFollowups(leadId);

  const [leadRow] = await db
    .select({
      id: leads.id,
      status: leads.status,
      contactId: leads.contactId,
      propertyId: leads.propertyId
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!leadRow || leadRow.status === "scheduled") {
    return;
  }

  const [appointment] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.leadId, leadId), ne(appointments.status, "canceled")))
    .limit(1);
  if (appointment?.id) {
    return;
  }

  const [contact] = await db
    .select({
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return;
  }

  const channel = await resolveFollowUpChannel(db, leadId, contact);
  if (!channel) {
    return;
  }

  const now = new Date();
  const steps = followupPolicy.stepsMinutes
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!steps.length) {
    return;
  }

  const firstStep = steps[0] ?? 24 * 60;
  const firstDue = new Date(now.getTime() + firstStep * 60_000);

  await db
    .insert(leadAutomationStates)
    .values({
      leadId,
      channel,
      paused: false,
      dnc: false,
      humanTakeover: false,
      followupState: "running",
      followupStep: 0,
      nextFollowupAt: firstDue,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [leadAutomationStates.leadId, leadAutomationStates.channel],
      set: {
        followupState: "running",
        followupStep: 0,
        nextFollowupAt: firstDue,
        updatedAt: now
      }
    });

  for (let step = 0; step < steps.length; step += 1) {
    const stepMinutes = steps[step];
    if (typeof stepMinutes !== "number") continue;
    const dueAt = new Date(now.getTime() + stepMinutes * 60_000);
    await db.insert(outboxEvents).values({
      type: "followup.send",
      payload: {
        leadId,
        channel,
        step,
        anchorAt: now.toISOString()
      },
      nextAttemptAt: dueAt
    });
  }
}

async function clearPendingReminders(appointmentId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "estimate.reminder"),
        isNull(outboxEvents.processedAt),
        sql`(payload->>'appointmentId') = ${appointmentId}`
      )
    );
}

async function scheduleAppointmentReminders(
  appointmentId: string,
  startAt: Date | null | undefined,
  options?: { reset?: boolean }
): Promise<void> {
  if (!startAt) {
    return;
  }

  const db = getDb();
  const confirmationPolicy = await getConfirmationLoopPolicy(db);
  if (!confirmationPolicy.enabled) {
    return;
  }

  if (options?.reset) {
    await clearPendingReminders(appointmentId);
  }

  const now = new Date();
  const windows = confirmationPolicy.windowsMinutes.length
    ? confirmationPolicy.windowsMinutes
    : [24 * 60, 2 * 60];

  for (const windowMinutes of windows) {
    const reminderAt = new Date(startAt.getTime() - windowMinutes * 60_000);
    if (reminderAt <= now) continue;

    const [existing] = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, "estimate.reminder"),
          isNull(outboxEvents.processedAt),
          sql`(payload->>'appointmentId') = ${appointmentId}`,
          sql`(payload->>'windowMinutes') = ${String(windowMinutes)}`
        )
      )
      .limit(1);

    if (existing?.id) {
      continue;
    }

    await db.insert(outboxEvents).values({
      type: "estimate.reminder",
      payload: {
        appointmentId,
        windowMinutes
      },
      nextAttemptAt: reminderAt
    });
  }
}

async function handleOutboxEvent(event: OutboxEventRecord): Promise<OutboxOutcome> {
  switch (event.type) {
    case "estimate.requested": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentIdValue = payload?.["appointmentId"];
      const appointmentId = typeof appointmentIdValue === "string" ? appointmentIdValue : null;
      if (!appointmentId) {
        console.warn("[outbox] estimate.requested.missing_appointment", { id: event.id });
        return { status: "skipped" };
      }

      const services = coerceServices(payload?.["services"]);
      const schedulingOverride = payload && isRecord(payload["scheduling"]) ? payload["scheduling"] : null;

      const notification = await buildNotificationPayload(appointmentId, {
        services,
        scheduling: schedulingOverride
          ? {
              preferredDate:
                typeof schedulingOverride["preferredDate"] === "string"
                  ? schedulingOverride["preferredDate"]
                  : undefined,
              alternateDate:
                typeof schedulingOverride["alternateDate"] === "string"
                  ? schedulingOverride["alternateDate"]
                  : undefined,
              timeWindow:
                typeof schedulingOverride["timeWindow"] === "string"
                  ? schedulingOverride["timeWindow"]
                  : undefined
            }
          : undefined,
        notes: typeof payload?.["notes"] === "string" ? payload["notes"] : undefined
      });

      if (!notification) {
        return { status: "skipped" };
      }

      await ensureCalendarEventCreated(notification);
      await sendEstimateConfirmation(notification, "requested");
      await scheduleAppointmentReminders(appointmentId, notification.appointment.startAt);
      await clearLeadFollowups(notification.leadId ?? null);
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "qualified",
        "estimate.requested",
        { appointmentId }
      );
      return { status: "processed" };
    }

    case "estimate.rescheduled": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentIdValue = payload?.["appointmentId"];
      const appointmentId = typeof appointmentIdValue === "string" ? appointmentIdValue : null;
      if (!appointmentId) {
        console.warn("[outbox] estimate.rescheduled.missing_appointment", { id: event.id });
        return { status: "skipped" };
      }

      const notification = await buildNotificationPayload(appointmentId, {
        services: coerceServices(payload?.["services"]),
        rescheduleUrl: typeof payload?.["rescheduleUrl"] === "string" ? payload["rescheduleUrl"] : undefined
      });

      if (!notification) {
        return { status: "skipped" };
      }

      await syncCalendarEventForReschedule(notification);
      await sendEstimateConfirmation(notification, "rescheduled");
      await scheduleAppointmentReminders(appointmentId, notification.appointment.startAt, { reset: true });
      await clearLeadFollowups(notification.leadId ?? null);
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "qualified",
        "estimate.rescheduled",
        { appointmentId }
      );
      return { status: "processed" };
    }

    case "quote.sent": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const quoteId = typeof payload?.["quoteId"] === "string" ? payload["quoteId"] : null;
      if (!quoteId) {
        console.warn("[outbox] quote.sent.missing_id", { id: event.id });
        return { status: "skipped" };
      }

      const shareToken =
        typeof payload?.["shareToken"] === "string" && payload["shareToken"].trim().length > 0
          ? payload["shareToken"].trim()
          : null;

      const notification = await buildQuoteNotificationPayload(quoteId, { shareToken });
      if (!notification) {
        return { status: "skipped" };
      }

      await sendQuoteSentNotification(notification);
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "quoted",
        "quote.sent",
        { quoteId }
      );
      if (notification.contactId) {
        const db = getDb();
        const [leadRow] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(eq(leads.contactId, notification.contactId))
          .orderBy(desc(leads.updatedAt), desc(leads.createdAt))
          .limit(1);
        if (leadRow?.id) {
          await scheduleLeadFollowups(leadRow.id, notification.contactId);
        }
      }
      return { status: "processed" };
    }

    case "quote.decision": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const quoteId = typeof payload?.["quoteId"] === "string" ? payload["quoteId"] : null;
      const rawDecision = typeof payload?.["decision"] === "string" ? payload["decision"] : null;
      const decision =
        rawDecision === "accepted" || rawDecision === "declined" ? rawDecision : null;
      if (!quoteId || !decision) {
        console.warn("[outbox] quote.decision.missing_data", { id: event.id });
        return { status: "skipped" };
      }

      const rawSource = typeof payload?.["source"] === "string" ? payload["source"] : null;
      const source: "customer" | "admin" =
        rawSource === "customer" || rawSource === "admin" ? rawSource : "customer";
      const notes = typeof payload?.["notes"] === "string" ? payload["notes"] : null;

      const notification = await buildQuoteNotificationPayload(quoteId, { notes });
      if (!notification) {
        return { status: "skipped" };
      }

      await sendQuoteDecisionNotification({
        ...notification,
        decision,
        source
      });
      const targetStage: PipelineStage = decision === "accepted" ? "won" : "lost";
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        targetStage,
        "quote.decision",
        { quoteId, decision, source }
      );
      if (notification.contactId) {
        const db = getDb();
        const [leadRow] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(eq(leads.contactId, notification.contactId))
          .orderBy(desc(leads.updatedAt), desc(leads.createdAt))
          .limit(1);
        await clearLeadFollowups(leadRow?.id ?? null);
      }
      return { status: "processed" };
    }

    case "estimate.status_changed":
    case "lead.created": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId = typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const status = typeof payload?.["status"] === "string" ? payload["status"] : null;
      const services = coerceServices(payload?.["services"]);
      const schedulingOverride = payload && isRecord(payload["scheduling"]) ? payload["scheduling"] : null;

      if (!leadId) {
        console.warn("[outbox] lead.created.missing_lead", { id: event.id });
        return { status: "skipped" };
      }

      const db = getDb();
      const rows = await db
        .select({
          id: appointments.id
        })
        .from(appointments)
        .where(eq(appointments.leadId, leadId))
        .limit(1);

      const appointment = rows[0];
      if (!appointment?.id) {
        console.info("[outbox] lead.created.no_appointment", { id: event.id, leadId });
        return { status: "skipped" };
      }

      const notification = await buildNotificationPayload(appointment.id, {
        services,
        scheduling: schedulingOverride
          ? {
              preferredDate:
                typeof schedulingOverride["preferredDate"] === "string"
                  ? schedulingOverride["preferredDate"]
                  : undefined,
              alternateDate:
                typeof schedulingOverride["alternateDate"] === "string"
                  ? schedulingOverride["alternateDate"]
                  : undefined,
              timeWindow:
                typeof schedulingOverride["timeWindow"] === "string"
                  ? schedulingOverride["timeWindow"]
                  : undefined
            }
          : undefined,
        notes: typeof payload?.["notes"] === "string" ? payload["notes"] : undefined
      });

      if (!notification) {
        return { status: "skipped" };
      }

      await sendEstimateConfirmation(notification, "requested");
      if (status === "canceled" || status === "no_show" || status === "completed") {
        await clearPendingReminders(appointment.id);
      }
      if (event.type === "estimate.status_changed") {
        await clearLeadFollowups(leadId);
      }
      if (notification.contactId) {
        const targetStage: PipelineStage =
          event.type === "estimate.status_changed" && status
            ? mapAppointmentStatusToStage(status)
            : "qualified";
        await updatePipelineStageForContact(notification.contactId, targetStage, event.type, {
          appointmentId: appointment.id,
          status: status ?? null
        });
      }
      return { status: "processed" };
    }

    case "lead.alert": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId = typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      if (!leadId) {
        console.warn("[outbox] lead.alert.missing_lead", { id: event.id });
        return { status: "skipped" };
      }

      const recipients = parseLeadAlertRecipients(process.env["LEAD_ALERT_SMS"]);
      if (!recipients.length) {
        return { status: "processed" };
      }

      const message = await buildLeadAlertMessage(leadId);
      if (!message) {
        return { status: "skipped" };
      }

      const sentTo = Array.isArray(payload?.["sentTo"])
        ? payload?.["sentTo"].filter((value): value is string => typeof value === "string")
        : [];
      const sentSet = new Set(sentTo);
      const pending = recipients.filter((recipient) => !sentSet.has(recipient));
      if (!pending.length) {
        return { status: "processed" };
      }

      let retryableFailure: string | null = null;
      let lastFailure: string | null = null;

      for (const recipient of pending) {
        const result = await sendSmsMessage(recipient, message.text);
        if (result.ok) {
          sentSet.add(recipient);
          await recordProviderSuccessSafe("sms");
          await recordAuditEvent({
            actor: { type: "worker", label: "outbox" },
            action: "lead.alert.sent",
            entityType: "lead",
            entityId: leadId,
            meta: { recipient, provider: result.provider ?? null }
          });
          continue;
        }

        const detail = result.detail ?? null;
        lastFailure = detail ?? "lead_alert_failed";
        const retryable = isRetryableSendFailure(detail);
        if (retryable) {
          retryableFailure = lastFailure;
        } else {
          await recordProviderFailureSafe("sms", detail);
        }

        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "lead.alert.failed",
          entityType: "lead",
          entityId: leadId,
          meta: { recipient, provider: result.provider ?? null, detail }
        });
      }

      const updatedPayload = {
        ...(payload ?? {}),
        sentTo: Array.from(sentSet)
      };
      await getDb()
        .update(outboxEvents)
        .set({ payload: updatedPayload })
        .where(eq(outboxEvents.id, event.id));

      if (retryableFailure) {
        return { status: "retry", error: retryableFailure };
      }

      return { status: "processed", error: lastFailure };
    }

    case "crm.reminder.sms": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const taskId = typeof payload?.["taskId"] === "string" ? payload["taskId"].trim() : "";
      if (!taskId) {
        console.warn("[outbox] crm.reminder.missing_task_id", { id: event.id });
        return { status: "skipped" };
      }

      const db = getDb();
      const [row] = await db
        .select({
          id: crmTasks.id,
          contactId: crmTasks.contactId,
          title: crmTasks.title,
          notes: crmTasks.notes,
          dueAt: crmTasks.dueAt,
          assignedTo: crmTasks.assignedTo,
          status: crmTasks.status,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164
        })
        .from(crmTasks)
        .leftJoin(contacts, eq(crmTasks.contactId, contacts.id))
        .where(eq(crmTasks.id, taskId))
        .limit(1);

      if (!row) {
        console.info("[outbox] crm.reminder.task_not_found", { id: event.id, taskId });
        return { status: "processed" };
      }

      if (row.status !== "open" || !row.dueAt) {
        console.info("[outbox] crm.reminder.not_open_or_missing_due", {
          id: event.id,
          taskId: row.id,
          status: row.status,
          dueAt: row.dueAt ? row.dueAt.toISOString() : null
        });
        return { status: "processed" };
      }

      const now = new Date();
      if (row.dueAt.getTime() > now.getTime() + 60_000) {
        console.info("[outbox] crm.reminder.not_due_yet", {
          id: event.id,
          taskId: row.id,
          dueAt: row.dueAt.toISOString(),
          nextAttemptAt: row.dueAt.toISOString()
        });
        return { status: "retry", nextAttemptAt: row.dueAt };
      }

      const phoneMap = await getTeamMemberPhoneMap(db);
      const recipient = row.assignedTo ? phoneMap[row.assignedTo] ?? null : null;
      if (!recipient) {
        console.warn("[outbox] crm.reminder.missing_recipient", {
          id: event.id,
          taskId: row.id,
          assignedTo: row.assignedTo ?? null,
          phoneMapCount: Object.keys(phoneMap).length
        });
        await recordProviderFailureSafe("sms", "missing_recipient");
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "crm.reminder.failed",
          entityType: "crm_task",
          entityId: row.id,
          meta: { detail: "missing_recipient", assignedTo: row.assignedTo ?? null }
        });
        return { status: "processed", error: "missing_recipient" };
      }

      const business = await getBusinessHoursPolicy(db);
      const contactName = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact";
      const contactPhone = row.phoneE164 ?? row.phone ?? null;
      const dueLabel = formatReminderDueAt(row.dueAt, business.timezone);
      const details =
        typeof row.notes === "string" && row.notes.trim().length > 0 ? `\n${row.notes.trim()}` : "";
      const contactLine = contactPhone ? ` (${contactPhone})` : "";

      const message =
        `Reminder: ${row.title}\n` +
        `${contactName}${contactLine}\n` +
        `Due: ${dueLabel}${details}`;

      console.info("[outbox] crm.reminder.sending", {
        id: event.id,
        taskId: row.id,
        assignedTo: row.assignedTo ?? null,
        recipient,
        dueAt: row.dueAt.toISOString()
      });

      const result = await sendSmsMessage(recipient, message);
      if (result.ok) {
        await recordProviderSuccessSafe("sms");
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "crm.reminder.sent",
          entityType: "crm_task",
          entityId: row.id,
          meta: { recipient, contactId: row.contactId, provider: result.provider ?? null }
        });
        return { status: "processed" };
      }

      const detail = result.detail ?? "reminder_send_failed";
      const retryable = isRetryableSendFailure(detail);
      console.warn("[outbox] crm.reminder.send_failed", {
        id: event.id,
        taskId: row.id,
        recipient,
        detail
      });

      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "crm.reminder.failed",
        entityType: "crm_task",
        entityId: row.id,
        meta: { recipient, contactId: row.contactId, provider: result.provider ?? null, detail }
      });

      if (retryable) {
        return { status: "retry", error: detail };
      }

      await recordProviderFailureSafe("sms", detail);
      return { status: "processed", error: detail };
    }

    case "meta.lead_event": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId = typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      if (!leadId) {
        console.warn("[outbox] meta.lead_event.missing_lead", { id: event.id });
        return { status: "skipped" };
      }

      const datasetId = process.env["META_DATASET_ID"];
      const accessToken = process.env["META_CONVERSIONS_TOKEN"];
      if (!datasetId || !accessToken) {
        console.warn("[outbox] meta.lead_event.missing_config", { id: event.id });
        return { status: "skipped" };
      }

      const leadEventSource =
        typeof process.env["META_LEAD_EVENT_SOURCE"] === "string" && process.env["META_LEAD_EVENT_SOURCE"].trim().length > 0
          ? process.env["META_LEAD_EVENT_SOURCE"].trim()
          : "StonegateOS";
      const eventName = typeof payload?.["eventName"] === "string" ? payload["eventName"] : "Lead";

      const db = getDb();
      const [row] = await db
        .select({
          leadId: leads.id,
          createdAt: leads.createdAt,
          formPayload: leads.formPayload,
          contactEmail: contacts.email,
          contactPhone: contacts.phone,
          contactPhoneE164: contacts.phoneE164
        })
        .from(leads)
        .leftJoin(contacts, eq(leads.contactId, contacts.id))
        .where(eq(leads.id, leadId))
        .limit(1);

      if (!row) {
        console.warn("[outbox] meta.lead_event.not_found", { id: event.id, leadId });
        return { status: "skipped" };
      }

      const formPayload = isRecord(row.formPayload) ? row.formPayload : null;
      const leadgenId = typeof formPayload?.["leadgenId"] === "string" ? formPayload["leadgenId"] : null;
      if (!leadgenId) {
        console.warn("[outbox] meta.lead_event.missing_leadgen", { id: event.id, leadId });
        return { status: "skipped" };
      }

      let eventTime = Math.floor((row.createdAt ?? new Date()).getTime() / 1000);
      const createdTimeRaw = typeof formPayload?.["createdTime"] === "string" ? formPayload["createdTime"] : null;
      if (createdTimeRaw) {
        const parsed = new Date(createdTimeRaw);
        if (!Number.isNaN(parsed.getTime())) {
          eventTime = Math.floor(parsed.getTime() / 1000);
        }
      }

      const userData: Record<string, unknown> = {
        lead_id: leadgenId
      };

      if (row.contactEmail) {
        const normalizedEmail = normalizeEmailForHash(row.contactEmail);
        if (normalizedEmail.length > 0) {
          userData["em"] = [hashSha256(normalizedEmail)];
        }
      }

      const phoneRaw = row.contactPhoneE164 ?? row.contactPhone;
      if (phoneRaw) {
        const normalizedPhone = normalizePhoneForHash(phoneRaw);
        if (normalizedPhone.length > 0) {
          userData["ph"] = [hashSha256(normalizedPhone)];
        }
      }

      const payloadBody = {
        data: [
          {
            action_source: "system_generated",
            custom_data: {
              event_source: "crm",
              lead_event_source: leadEventSource
            },
            event_name: eventName,
            event_time: eventTime,
            user_data: userData
          }
        ]
      };

      const response = await fetch(
        `https://graph.facebook.com/v24.0/${datasetId}/events?access_token=${accessToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadBody)
        }
      );

      if (!response.ok) {
        const text = await response.text();
        const retryable = response.status >= 500 || response.status === 429;
        console.warn("[outbox] meta.lead_event.failed", {
          id: event.id,
          status: response.status,
          error: text
        });
        return retryable ? { status: "retry", error: text } : { status: "processed", error: text };
      }

      return { status: "processed" };
    }

    case "meta.ads_insights.sync": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const daysRaw = payload?.["days"];
      const days =
        typeof daysRaw === "number"
          ? daysRaw
          : typeof daysRaw === "string"
            ? Number(daysRaw)
            : NaN;
      const sinceRaw = typeof payload?.["since"] === "string" ? payload["since"] : null;
      const untilRaw = typeof payload?.["until"] === "string" ? payload["until"] : null;

      const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
      const isIsoDateString = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

      let since = sinceRaw && isIsoDateString(sinceRaw) ? sinceRaw : null;
      let until = untilRaw && isIsoDateString(untilRaw) ? untilRaw : null;

      if (!since || !until || since > until) {
        const windowDays = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 90) : 14;
        const now = new Date();
        const end = isoDate(now);
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - (windowDays - 1));
        const start = isoDate(startDate);
        since = start;
        until = end;
      }

      try {
        const result = await syncMetaAdsInsightsDaily({ since, until });
        await recordProviderSuccessSafe("meta_ads");
        console.info("[outbox] meta.ads_insights.sync.ok", { id: event.id, since, until, ...result });
        return {
          status: "processed"
        };
      } catch (error) {
        const detail =
          error instanceof MetaGraphApiError
            ? `meta_ads_insights_failed:${error.status}:${error.body}`
            : `meta_ads_insights_error:${String(error)}`;

        await recordProviderFailureSafe("meta_ads", detail);

        const retryable =
          error instanceof MetaGraphApiError ? error.status === 429 || error.status >= 500 : true;

        return retryable ? { status: "retry", error: detail } : { status: "processed", error: detail };
      }
    }

    case "estimate.reminder": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentId = typeof payload?.["appointmentId"] === "string" ? payload["appointmentId"] : null;
      const rawWindow = payload?.["windowMinutes"];
      const windowMinutes =
        typeof rawWindow === "number"
          ? rawWindow
          : typeof rawWindow === "string"
            ? Number(rawWindow)
            : NaN;

      if (!appointmentId || !Number.isFinite(windowMinutes)) {
        console.warn("[outbox] estimate.reminder.missing_data", { id: event.id });
        return { status: "skipped" };
      }

      const confirmationPolicy = await getConfirmationLoopPolicy();
      if (!confirmationPolicy.enabled || !confirmationPolicy.windowsMinutes.includes(windowMinutes)) {
        return { status: "processed" };
      }

      const notification = await buildNotificationPayload(appointmentId);
      if (!notification) {
        return { status: "skipped" };
      }
      if (
        notification.appointment.status === "canceled" ||
        notification.appointment.status === "no_show" ||
        notification.appointment.status === "completed"
      ) {
        return { status: "skipped" };
      }

      await sendEstimateReminder(notification, windowMinutes);
      return { status: "processed" };
    }

    case "followup.schedule": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId = typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const contactId = typeof payload?.["contactId"] === "string" ? payload["contactId"] : null;

      if (!leadId || !contactId) {
        console.warn("[outbox] followup.schedule.missing_data", { id: event.id });
        return { status: "skipped" };
      }

      await scheduleLeadFollowups(leadId, contactId);
      return { status: "processed" };
    }

    case "followup.send": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId = typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const channelRaw = typeof payload?.["channel"] === "string" ? payload["channel"] : null;
      const step = typeof payload?.["step"] === "number" ? payload["step"] : Number(payload?.["step"]);
      const anchorAtRaw = typeof payload?.["anchorAt"] === "string" ? payload["anchorAt"] : null;

      if (!leadId || (channelRaw !== "sms" && channelRaw !== "email") || !Number.isFinite(step)) {
        console.warn("[outbox] followup.send.missing_data", { id: event.id });
        return { status: "skipped" };
      }
      const channel = channelRaw as FollowUpChannel;

      const followupPolicy = await getFollowUpSequencePolicy();
      if (!followupPolicy.enabled) {
        return { status: "processed" };
      }

      const steps = followupPolicy.stepsMinutes
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      if (!steps.length || step < 0 || step >= steps.length) {
        return { status: "processed" };
      }

      const db = getDb();
      const [leadRow] = await db
        .select({
          id: leads.id,
          status: leads.status,
          contactId: leads.contactId,
          propertyId: leads.propertyId
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);

      if (!leadRow) {
        return { status: "skipped" };
      }

      if (leadRow.status === "scheduled") {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const [appointment] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.leadId, leadId), ne(appointments.status, "canceled")))
        .limit(1);

      if (appointment?.id) {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const state = await getLeadAutomationState(db, leadId, channel);
      if (state.paused || state.dnc || state.humanTakeover || state.followupState === "stopped") {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const mode = await getAutomationMode(db, channel);
      if (mode === "draft") {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const [contact] = await db
        .select({ email: contacts.email, phone: contacts.phone, phoneE164: contacts.phoneE164 })
        .from(contacts)
        .where(eq(contacts.id, leadRow.contactId))
        .limit(1);

      const toAddress = contact ? getContactChannelAddress(contact, channel) : null;
      if (!toAddress) {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const threadId = await ensureThreadForLead(db, {
        leadId,
        contactId: leadRow.contactId,
        propertyId: leadRow.propertyId ?? null,
        channel
      });
      if (!threadId) {
        await clearLeadFollowups(leadId);
        return { status: "processed" };
      }

      const templates = await getTemplatesPolicy(db);
      const body =
        resolveTemplateForChannel(templates.follow_up, { replyChannel: channel }) ??
        "Just checking in - do you want to lock in a time for your junk removal?";
      const subject = channel === "email" ? "Stonegate follow-up" : null;

      const messageId = await queueOutboundMessage({
        db,
        threadId,
        channel,
        body,
        toAddress,
        subject,
        metadata: {
          followup: true,
          followupStep: step,
          leadId
        }
      });

      if (!messageId) {
        return { status: "retry", error: "followup_message_failed" };
      }

      const anchorAt = anchorAtRaw ? new Date(anchorAtRaw) : new Date();
      const anchor = Number.isNaN(anchorAt.getTime()) ? new Date() : anchorAt;
      const nextStep = step + 1;
      const nextStepMinutes = nextStep < steps.length ? steps[nextStep] : undefined;
      const nextDue =
        typeof nextStepMinutes === "number"
          ? new Date(anchor.getTime() + nextStepMinutes * 60_000)
          : null;

      await db
        .update(leadAutomationStates)
        .set({
          followupState: nextDue ? "running" : "completed",
          followupStep: nextStep,
          nextFollowupAt: nextDue,
          updatedAt: new Date()
        })
        .where(and(eq(leadAutomationStates.leadId, leadId), eq(leadAutomationStates.channel, channel)));

      return { status: "processed" };
    }

    case "message.received": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId = typeof payload?.["messageId"] === "string" ? payload["messageId"] : null;
      if (!messageId) {
        console.warn("[outbox] message.received.missing_id", { id: event.id });
        return { status: "skipped" };
      }

      return await handleInboundAutoReply(messageId);
    }

    case "message.send": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId = typeof payload?.["messageId"] === "string" ? payload["messageId"] : null;
      if (!messageId) {
        console.warn("[outbox] message.send.missing_id", { id: event.id });
        return { status: "skipped" };
      }

      const db = getDb();
      const rows = await db
        .select({
          id: conversationMessages.id,
          threadId: conversationMessages.threadId,
          channel: conversationMessages.channel,
          body: conversationMessages.body,
          subject: conversationMessages.subject,
          toAddress: conversationMessages.toAddress,
          metadata: conversationMessages.metadata,
          sentAt: conversationMessages.sentAt,
          contactId: conversationThreads.contactId,
          contactPhone: contacts.phone,
          contactPhoneE164: contacts.phoneE164,
          contactEmail: contacts.email
        })
        .from(conversationMessages)
        .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .where(eq(conversationMessages.id, messageId))
        .limit(1);

      const message = rows[0];
      if (!message) {
        console.warn("[outbox] message.send.not_found", { messageId });
        return { status: "skipped" };
      }

      const channel = message.channel ?? "sms";
      const subject = message.subject ?? "Stonegate message";
      const body = message.body ?? "";
      let toAddress = message.toAddress ?? null;
      let metadata = isRecord(message.metadata) ? message.metadata : null;

      if (!toAddress) {
        if (channel === "sms") {
          toAddress = message.contactPhoneE164 ?? message.contactPhone ?? null;
        } else if (channel === "email") {
          toAddress = message.contactEmail ?? null;
        } else if (channel === "dm") {
          toAddress = await resolveDmRecipient(db, message.threadId);
        }
      }

      if (channel === "dm") {
        const resolvedMetadata = await resolveDmSendMetadata(db, message.threadId, metadata);
        if (resolvedMetadata !== metadata) {
          metadata = resolvedMetadata;
          await db
            .update(conversationMessages)
            .set({ metadata })
            .where(eq(conversationMessages.id, message.id));
        }
      }

      const now = new Date();
      const isAutomated =
        metadata?.["autoReply"] === true ||
        metadata?.["followup"] === true ||
        metadata?.["confirmationLoop"] === true ||
        metadata?.["automation"] === true;
      const bypassQuietHours = metadata?.["autoReply"] === true || metadata?.["confirmationLoop"] === true;

      if (isAutomated && !bypassQuietHours) {
        const quietHours = await getQuietHoursPolicy(db);
        const businessHours = await getBusinessHoursPolicy(db);
        const quietUntil = nextQuietHoursEnd(now, channel, quietHours, businessHours.timezone);
        if (quietUntil) {
          return { status: "retry", error: "quiet_hours", nextAttemptAt: quietUntil };
        }
      }
      const attempt = (event.attempts ?? 0) + 1;

      const delayFromMeta =
        readMetaNumber(metadata, "humanisticDelayMs") ?? readMetaNumber(metadata, "autoReplyDelayMs");
      const delayMs =
        channel === "dm" ? delayFromMeta ?? (isAutomated ? randomHumanisticDelayMs() : null) : null;
      const typingSentAt = typeof metadata?.["dmTypingSentAt"] === "string" ? metadata?.["dmTypingSentAt"] : null;

      if (channel === "dm" && delayMs && !typingSentAt && toAddress) {
        const typingResult = await sendDmTyping(toAddress, "typing_on", metadata);
        if (!typingResult.ok) {
          console.warn("[outbox] dm.typing_failed", { messageId, detail: typingResult.detail });
        }

        const updatedMetadata = mergeMetadata(metadata, {
          dmTypingSentAt: now.toISOString(),
          humanisticDelayMs: delayMs
        });
        await db
          .update(conversationMessages)
          .set({ metadata: updatedMetadata })
          .where(eq(conversationMessages.id, message.id));

        return {
          status: "retry",
          error: "dm_typing_delay",
          nextAttemptAt: new Date(now.getTime() + delayMs)
        };
      }

      if (!toAddress) {
        await db
          .update(conversationMessages)
          .set({ deliveryStatus: "failed" })
          .where(eq(conversationMessages.id, message.id));
        await db.insert(messageDeliveryEvents).values({
          messageId: message.id,
          status: "failed",
          detail: "missing_recipient",
          provider: null,
          occurredAt: now
        });
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "message.failed",
          entityType: "conversation_message",
          entityId: message.id,
          meta: { channel, reason: "missing_recipient" }
        });
        return { status: "processed" };
      }

      let result: Awaited<ReturnType<typeof sendSmsMessage>>;
      if (channel === "sms") {
        result = await sendSmsMessage(toAddress, body);
      } else if (channel === "email") {
        result = await sendEmailMessage(toAddress, subject, body);
      } else if (channel === "dm") {
        result = await sendDmMessage(toAddress, body, metadata);
      } else {
        result = { ok: false, provider: "unknown", detail: "unsupported_channel" };
      }

      const detail = result.detail ?? null;

      if (!result.ok) {
        const retryable = isRetryableSendFailure(detail);
        const canRetry = retryable && attempt < MAX_MESSAGE_SEND_ATTEMPTS;
        const providerHealth = channel === "sms" || channel === "email" ? channel : null;

        await db
          .update(conversationMessages)
          .set({
            deliveryStatus: canRetry ? "queued" : "failed",
            provider: result.provider ?? null,
            providerMessageId: result.providerMessageId ?? null,
            toAddress
          })
          .where(eq(conversationMessages.id, message.id));

        await db.insert(messageDeliveryEvents).values({
          messageId: message.id,
          status: "failed",
          detail,
          provider: result.provider ?? null,
          occurredAt: now
        });

        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "message.failed",
          entityType: "conversation_message",
          entityId: message.id,
          meta: {
            channel,
            toAddress,
            provider: result.provider ?? null,
            detail,
            attempt,
            willRetry: canRetry
          }
        });

        if (providerHealth) {
          await recordProviderFailureSafe(providerHealth, detail);
        }

        if (canRetry) {
          return { status: "retry", error: detail ?? "send_failed" };
        }

        return { status: "processed", error: detail ?? "send_failed" };
      }

      await db
        .update(conversationMessages)
        .set({
          deliveryStatus: "sent",
          provider: result.provider ?? null,
          providerMessageId: result.providerMessageId ?? null,
          sentAt: now,
          toAddress
        })
        .where(eq(conversationMessages.id, message.id));

      await db.insert(messageDeliveryEvents).values({
        messageId: message.id,
        status: "sent",
        detail,
        provider: result.provider ?? null,
        occurredAt: now
      });

      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "message.sent",
        entityType: "conversation_message",
        entityId: message.id,
        meta: {
          channel,
          toAddress,
          provider: result.provider ?? null,
          detail
        }
      });

      if (channel === "dm" && typingSentAt && toAddress) {
        const typingOff = await sendDmTyping(toAddress, "typing_off", metadata);
        if (!typingOff.ok) {
          console.warn("[outbox] dm.typing_off_failed", { messageId, detail: typingOff.detail });
        }
      }

      if (channel === "sms" || channel === "email") {
        await recordProviderSuccessSafe(channel);
      }

      return { status: "processed" };
    }

    default:
      return { status: "skipped" };
  }
}

export async function processOutboxBatch(
  options: ProcessOutboxBatchOptions = {}
): Promise<OutboxBatchStats> {
  const db = getDb();
  const { limit = 10 } = options;
  const now = new Date();

  const events = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        isNull(outboxEvents.processedAt),
        or(isNull(outboxEvents.nextAttemptAt), lte(outboxEvents.nextAttemptAt, now))
      )
    )
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit);

  const stats: OutboxBatchStats = {
    total: events.length,
    processed: 0,
    skipped: 0,
    errors: 0
  };

  for (const event of events) {
    let outcome: OutboxOutcome = { status: "skipped" };
    try {
      outcome = await handleOutboxEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = (event.attempts ?? 0) + 1;
      const canRetry = event.type === "message.send" && attempt < MAX_MESSAGE_SEND_ATTEMPTS;
      outcome = canRetry ? { status: "retry", error: message } : { status: "processed", error: message };
      console.warn("[outbox] handler_error", { id: event.id, type: event.type, error: message });
    }

    if (outcome.status === "processed") {
      stats.processed += 1;
    } else if (outcome.status === "skipped") {
      stats.skipped += 1;
    } else {
      stats.errors += 1;
    }

    const attempt = (event.attempts ?? 0) + 1;
    const lastError = outcome.error ?? null;
    try {
      if (outcome.status === "retry") {
        const retryDelayMs = getRetryDelayMs(attempt);
        await db
          .update(outboxEvents)
          .set({
            attempts: attempt,
            nextAttemptAt: outcome.nextAttemptAt ?? new Date(Date.now() + retryDelayMs),
            lastError
          })
          .where(eq(outboxEvents.id, event.id));
      } else {
        await db
          .update(outboxEvents)
          .set({
            attempts: attempt,
            processedAt: new Date(),
            nextAttemptAt: null,
            lastError
          })
          .where(eq(outboxEvents.id, event.id));
      }
    } catch (error) {
      console.warn("[outbox] mark_processed_failed", { id: event.id, error: String(error) });
    }
  }

  return stats;
}
