import { DateTime } from "luxon";
import {
  generateEstimateNotificationCopy,
  generateQuoteNotificationCopy,
} from "@/lib/ai";
import {
  joinServiceLabels,
  summarizeServiceLabels,
} from "@/lib/service-labels";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import { quoteSentMessageDedupeKey } from "@/lib/quote-outbox-contract";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";

interface BaseContact {
  name: string;
  email?: string | null;
  phone?: string | null;
}

interface BaseProperty {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface EstimateNotificationPayload {
  leadId: string;
  services: string[];
  contact: BaseContact;
  property: BaseProperty;
  contactId?: string;
  propertyId?: string;
  scheduling: {
    preferredDate: string | null;
    alternateDate: string | null;
    timeWindow: string | null;
  };
  appointment: {
    id: string;
    startAt: Date | null;
    durationMinutes: number;
    travelBufferMinutes: number;
    status: "requested" | "confirmed" | "completed" | "no_show" | "canceled";
    rescheduleToken: string;
    rescheduleUrl?: string;
    calendarEventId?: string | null;
  };
  notes?: string | null;
}

type ConfirmationReason = "requested" | "rescheduled";

export function notificationOperationDedupeKey(
  baseKey: string,
  operationId?: string | null,
): string {
  return operationId ? `${baseKey}:${operationId}` : baseKey;
}

export type AppointmentNotificationAuthorizationEvidence = {
  sourceStatusOutboxEventId: string;
  sourceStatusAuditEventId: string;
  sourceCorrelationId: string;
  sourceOperationId: string;
  sourceActorId: string;
  sourceAuthMethod: "team_session" | "break_glass";
  sourceRequiredPermission: "messages.send";
};

export async function sendEstimateCancellation(
  payload: EstimateNotificationPayload,
  operationId?: string | null,
  authorization?: AppointmentNotificationAuthorizationEvidence | null,
): Promise<void> {
  const { contact, appointment } = payload;
  const when = formatDateTime(appointment.startAt);

  const smsBody = `Stonegate: Your appointment for ${when} was canceled. Reply here if you want to rebook.`;
  const emailSubject = `Canceled: Stonegate appointment ${when}`;
  const emailBody = `Your Stonegate Junk Removal appointment for ${when} was canceled.\n\nReply to this email (or text us) if you want to rebook.`;

  if (contact.phone) {
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "sms",
        toAddress: contact.phone,
        body: smsBody,
        metadata: {
          confirmationLoop: true,
          kind: "estimate.canceled",
          leadId: payload.leadId,
          appointmentId: appointment.id,
          ...(authorization ?? {}),
        },
        dedupeKey: notificationOperationDedupeKey(
          `estimate.canceled:${appointment.id}`,
          operationId,
        ),
      });
    } else {
      await sendSms(contact.phone, smsBody, {
        leadId: payload.leadId,
        appointmentId: appointment.id,
      });
    }
  }

  if (contact.email) {
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "email",
        toAddress: contact.email,
        subject: emailSubject,
        body: emailBody,
        metadata: {
          confirmationLoop: true,
          kind: "estimate.canceled",
          leadId: payload.leadId,
          appointmentId: appointment.id,
          ...(authorization ?? {}),
        },
        dedupeKey: notificationOperationDedupeKey(
          `estimate.canceled:${appointment.id}:email`,
          operationId,
        ),
      });
    } else {
      await sendPlainEmail(contact.email, emailSubject, emailBody, {
        leadId: payload.leadId,
        appointmentId: appointment.id,
      });
    }
  }
}

export interface QuoteNotificationPayload {
  quoteId: string;
  services: string[];
  contact: BaseContact;
  contactId?: string;
  total: number;
  depositDue: number;
  balanceDue: number;
  shareUrl: string;
  expiresAt: Date | null;
  notes?: string | null;
}

const QUOTE_LINK_AI_PLACEHOLDER = "https://quote-link.invalid/customer-access";

type GeneratedQuoteCopy = {
  emailSubject?: string | null;
  emailBody?: string | null;
  smsBody?: string | null;
};

/**
 * The public quote URL is a bearer capability. AI may help draft surrounding
 * copy, but it receives only a non-secret placeholder. Generated bodies are
 * usable only when the placeholder survives exactly; replacement happens
 * locally immediately before durable customer-message creation.
 */
function materializeGeneratedQuoteCopy(
  generated: GeneratedQuoteCopy | null,
  shareUrl: string,
): GeneratedQuoteCopy | null {
  if (!generated) return null;
  const replaceLink = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.includes(QUOTE_LINK_AI_PLACEHOLDER)
      ? value.replaceAll(QUOTE_LINK_AI_PLACEHOLDER, shareUrl)
      : null;
  return {
    emailSubject:
      typeof generated.emailSubject === "string" &&
      !generated.emailSubject.includes(QUOTE_LINK_AI_PLACEHOLDER)
        ? generated.emailSubject
        : null,
    emailBody: replaceLink(generated.emailBody),
    smsBody: replaceLink(generated.smsBody),
  };
}

const DEFAULT_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ??
  process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
  "America/New_York";

function isLocalhostUrl(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    lowered.includes("localhost") ||
    lowered.includes("127.0.0.1") ||
    lowered.includes("0.0.0.0") ||
    lowered.includes("[::1]")
  );
}

function formatDateTime(date: Date | null): string {
  if (!date) {
    return "TBD";
  }

  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone(DEFAULT_TIME_ZONE)
    .toLocaleString(DateTime.DATETIME_MED);
}

export function formatAppointmentArrivalWindow(
  date: Date | null,
  windowMinutes = 30,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  if (!date) {
    return "TBD";
  }

  const start = DateTime.fromJSDate(date, { zone: "utc" }).setZone(timeZone);
  if (!start.isValid) {
    return "TBD";
  }

  const end = start.plus({ minutes: Math.max(1, windowMinutes) });
  if (!end.isValid) {
    return start.toLocaleString(DateTime.DATETIME_MED);
  }

  if (start.hasSame(end, "day")) {
    return `${start.toLocaleString(DateTime.DATE_MED)}, ${start.toLocaleString(
      DateTime.TIME_SIMPLE,
    )} - ${end.toLocaleString(DateTime.TIME_SIMPLE)}`;
  }

  return `${start.toLocaleString(DateTime.DATETIME_MED)} - ${end.toLocaleString(
    DateTime.DATETIME_MED,
  )}`;
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

function createIcsAttachment(payload: EstimateNotificationPayload): {
  filename: string;
  content: string;
  contentType: string;
} | null {
  const { appointment, contact, property } = payload;
  if (!appointment.startAt) {
    return null;
  }

  const start = DateTime.fromJSDate(appointment.startAt, { zone: "utc" });
  const end = start.plus({ minutes: appointment.durationMinutes ?? 60 });
  const stamp = DateTime.utc();

  const summary = `Stonegate Junk Removal - ${contact.name}`;
  const descriptionLines = [
    `Services: ${joinServiceLabels(payload.services)}`,
    payload.notes ? `Notes: ${payload.notes}` : null,
    appointment.rescheduleUrl
      ? `Reschedule: ${appointment.rescheduleUrl}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\\n");

  const location = `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`;

  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stonegate//Appointment Scheduler//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(`${appointment.id}@myst-os`)}`,
    `DTSTAMP:${stamp.toFormat("yyyyLLdd'T'HHmmss'Z'")}`,
    `DTSTART:${start.toFormat("yyyyLLdd'T'HHmmss'Z'")}`,
    `DTEND:${end.toFormat("yyyyLLdd'T'HHmmss'Z'")}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(descriptionLines)}`,
    `LOCATION:${escapeIcs(location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  return {
    filename: "stonegate-appointment.ics",
    content,
    contentType: "text/calendar; charset=utf-8; method=REQUEST",
  };
}

async function sendSms(
  to: string,
  body: string,
  context: Record<string, unknown>,
): Promise<void> {
  // These contactless compatibility notifications still use the shared
  // provider boundary. Never place phone numbers, message bodies, provider
  // response text, or caller-supplied identifiers in operational logs.
  void context;
  const result = await sendSmsMessage(to, body);
  if (!result.ok) {
    console.warn("[notify] sms.delivery_failed", {
      certainty: result.deliveryCertainty ?? "uncertain",
      detail: result.detail ?? "sms_provider_failed",
    });
  }
}

async function sendEmail(
  payload: EstimateNotificationPayload,
  subject: string,
  textBody: string,
): Promise<void> {
  const to = payload.contact.email;

  if (!to) return;

  const ics = createIcsAttachment(payload);
  const result = await sendEmailMessage(to, subject, textBody, {
    emailAttachments: ics ? [ics] : undefined,
  });
  if (!result.ok) {
    console.warn("[notify] email.delivery_failed", {
      certainty: result.deliveryCertainty ?? "uncertain",
      detail: result.detail ?? "email_provider_failed",
    });
  }
}

async function sendPlainEmail(
  to: string | null | undefined,
  subject: string,
  textBody: string,
  context: Record<string, unknown>,
): Promise<void> {
  void context;
  if (!to) return;
  const result = await sendEmailMessage(to, subject, textBody);
  if (!result.ok) {
    console.warn("[notify] email.delivery_failed", {
      certainty: result.deliveryCertainty ?? "uncertain",
      detail: result.detail ?? "email_provider_failed",
    });
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function getQuoteAlertRecipients(): string[] {
  const raw = process.env["QUOTE_ALERT_EMAIL"];
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function servicesSummary(services: string[]): string {
  return summarizeServiceLabels(services);
}

function buildRescheduleUrl(
  appointment: EstimateNotificationPayload["appointment"],
): string | null {
  if (appointment.rescheduleUrl) {
    try {
      const parsed = new URL(appointment.rescheduleUrl);
      const allowInsecure =
        process.env["NODE_ENV"] === "development" ||
        process.env["NODE_ENV"] === "test";
      if (
        !isLocalhostUrl(appointment.rescheduleUrl) &&
        (allowInsecure || parsed.protocol === "https:")
      ) {
        return appointment.rescheduleUrl;
      }
    } catch {
      // ignore
    }
  }

  const base = resolvePublicSiteBaseUrl();
  if (!base) return null;

  const url = new URL("/schedule", base);
  url.searchParams.set("appointmentId", appointment.id);
  url.searchParams.set("token", appointment.rescheduleToken);
  return url.toString();
}

function joinServices(services: string[]): string {
  return joinServiceLabels(services);
}

export async function sendEstimateConfirmation(
  payload: EstimateNotificationPayload,
  reason: ConfirmationReason = "requested",
  operationId?: string | null,
): Promise<void> {
  const { contact, appointment, property, scheduling } = payload;
  const when = formatAppointmentArrivalWindow(appointment.startAt);
  const rescheduleUrl = buildRescheduleUrl(appointment);
  const headline =
    reason === "requested" ? "You're booked!" : "Appointment updated";

  const fallbackSubject = `Stonegate Junk Removal - ${when}`;
  const fallbackBody = [
    `${headline} We'll see you ${when}.`,
    `Location: ${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
    `Services: ${joinServices(payload.services)}`,
    scheduling.timeWindow ? `Preferred window: ${scheduling.timeWindow}` : null,
    payload.notes ? `Notes: ${payload.notes}` : null,
    "",
    rescheduleUrl ? `Need to reschedule? ${rescheduleUrl}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms =
    reason === "requested"
      ? `Stonegate: You're booked for ${when}. Reply here if you need changes.`
      : `Stonegate: Updated appointment to ${when}. Reply here if you need changes.`;

  let generated = null;
  if (rescheduleUrl) {
    try {
      generated = await generateEstimateNotificationCopy({
        when,
        services: payload.services,
        notes: payload.notes,
        rescheduleUrl,
        reason,
        address: {
          line1: property.addressLine1,
          city: property.city,
          state: property.state,
          postalCode: property.postalCode,
        },
        contactName: contact.name,
      });
    } catch (error) {
      console.warn("[notify] ai.copy.error", { error: String(error) });
    }
  }

  if (contact.phone) {
    const smsBody = fallbackSms;
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "sms",
        toAddress: contact.phone,
        body: smsBody,
        metadata: {
          confirmationLoop: true,
          kind: "estimate.confirmation",
          reason,
          leadId: payload.leadId,
          appointmentId: appointment.id,
        },
        dedupeKey: notificationOperationDedupeKey(
          `estimate.confirmation:${appointment.id}:${reason}`,
          operationId,
        ),
      });
    } else {
      await sendSms(contact.phone, smsBody, {
        leadId: payload.leadId,
        appointmentId: appointment.id,
      });
    }
  }

  const emailSubject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const emailBody =
    generated?.emailBody && generated.emailBody.length <= 1000
      ? generated.emailBody
      : fallbackBody;
  if (contact.email && payload.contactId) {
    const calendarAttachment = createIcsAttachment(payload);
    await queueSystemOutboundMessage({
      contactId: payload.contactId,
      channel: "email",
      toAddress: contact.email,
      subject: emailSubject,
      body: emailBody,
      metadata: {
        confirmationLoop: true,
        kind: "estimate.confirmation",
        reason,
        leadId: payload.leadId,
        appointmentId: appointment.id,
        emailAttachments: calendarAttachment ? [calendarAttachment] : [],
      },
      dedupeKey: notificationOperationDedupeKey(
        `estimate.confirmation:${appointment.id}:${reason}:email`,
        operationId,
      ),
    });
  } else {
    await sendEmail(payload, emailSubject, emailBody);
  }
}

interface ReminderOptions {
  windowMinutes: number;
  operationId?: string | null;
}

async function sendEstimateReminderInternal(
  payload: EstimateNotificationPayload,
  options: ReminderOptions,
): Promise<void> {
  const { contact, appointment } = payload;
  const when = formatAppointmentArrivalWindow(appointment.startAt);
  const rescheduleUrl = buildRescheduleUrl(appointment);
  const windowHours = Math.round(options.windowMinutes / 60);

  const fallbackSms = rescheduleUrl
    ? `Stonegate reminder: appointment in ${windowHours}h (${when}). Need to reschedule? ${rescheduleUrl}`
    : `Stonegate reminder: appointment in ${windowHours}h (${when}). Reply here if you need changes.`;
  const fallbackEmailBody = [
    `Quick reminder: your Stonegate Junk Removal appointment is in ${windowHours} hours (${when}).`,
    `Location: ${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
    "",
    rescheduleUrl
      ? `Need to adjust? ${rescheduleUrl}`
      : "Need to adjust? Reply to this message.",
  ].join("\n");
  const fallbackSubject = `Reminder: Stonegate appointment ${when}`;

  let generated = null;
  if (rescheduleUrl) {
    try {
      generated = await generateEstimateNotificationCopy({
        when,
        services: payload.services,
        notes: payload.notes,
        rescheduleUrl,
        reason: "reminder",
        reminderWindowHours: windowHours,
        address: {
          line1: payload.property.addressLine1,
          city: payload.property.city,
          state: payload.property.state,
          postalCode: payload.property.postalCode,
        },
        contactName: payload.contact.name,
      });
    } catch (error) {
      console.warn("[notify] reminder.ai.error", { error: String(error) });
    }
  }

  if (contact.phone) {
    const smsBody =
      generated?.smsBody && generated.smsBody.length <= 320
        ? generated.smsBody
        : fallbackSms;
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "sms",
        toAddress: contact.phone,
        body: smsBody,
        metadata: {
          confirmationLoop: true,
          kind: "estimate.reminder",
          leadId: payload.leadId,
          appointmentId: appointment.id,
          reminderMinutes: options.windowMinutes,
        },
        dedupeKey: notificationOperationDedupeKey(
          `estimate.reminder:${appointment.id}:${options.windowMinutes}`,
          options.operationId,
        ),
      });
    } else {
      await sendSms(contact.phone, smsBody, {
        leadId: payload.leadId,
        appointmentId: appointment.id,
        reminderMinutes: options.windowMinutes,
      });
    }
  }

  const to = payload.contact.email;
  const subject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const text =
    generated?.emailBody && generated.emailBody.length <= 1000
      ? generated.emailBody
      : fallbackEmailBody;

  if (to && payload.contactId) {
    await queueSystemOutboundMessage({
      contactId: payload.contactId,
      channel: "email",
      toAddress: to,
      subject,
      body: text,
      metadata: {
        confirmationLoop: true,
        kind: "estimate.reminder",
        leadId: payload.leadId,
        appointmentId: appointment.id,
        reminderMinutes: options.windowMinutes,
      },
      dedupeKey: notificationOperationDedupeKey(
        `estimate.reminder:${appointment.id}:${options.windowMinutes}:email`,
        options.operationId,
      ),
    });
  } else if (to) {
    await sendPlainEmail(to, subject, text, {
      type: "estimate.reminder",
    });
  }
}

export async function sendEstimateReminder(
  payload: EstimateNotificationPayload,
  windowMinutes: number,
  operationId?: string | null,
): Promise<void> {
  await sendEstimateReminderInternal(payload, { windowMinutes, operationId });
}

export async function sendEstimateReminder24h(
  payload: EstimateNotificationPayload,
): Promise<void> {
  await sendEstimateReminder(payload, 24 * 60);
}

export async function sendEstimateReminder2h(
  payload: EstimateNotificationPayload,
): Promise<void> {
  await sendEstimateReminder(payload, 2 * 60);
}

export async function sendQuoteSentNotification(
  payload: QuoteNotificationPayload & { sendAttemptId: string },
): Promise<void> {
  const expiresIso = payload.expiresAt ? payload.expiresAt.toISOString() : null;
  const paymentTerms =
    payload.depositDue > 0
      ? `Deposit listed on quote: ${formatCurrency(payload.depositDue)}. Balance due after service: ${formatCurrency(payload.balanceDue)}.`
      : "No deposit is required; payment is due after the work is complete.";

  const fallbackSubject = "Your Stonegate Junk Removal quote is ready";
  const fallbackBody = [
    `Hi ${payload.contact.name},`,
    "",
    `Your quote for ${joinServiceLabels(payload.services)} is ready.`,
    `Total: ${formatCurrency(payload.total)}.`,
    paymentTerms,
    `Review and approve: ${payload.shareUrl}`,
    expiresIso ? `Expires: ${expiresIso}` : null,
    "",
    "We appreciate the opportunity to help.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms =
    payload.depositDue > 0
      ? `Stonegate quote ready: ${formatCurrency(payload.total)} (${formatCurrency(payload.depositDue)} deposit listed). Review ${payload.shareUrl}`
      : `Stonegate quote ready: ${formatCurrency(payload.total)}. Review ${payload.shareUrl}`;

  let generated: GeneratedQuoteCopy | null = null;
  try {
    const generatedDraft = await generateQuoteNotificationCopy({
      customerName: payload.contact.name,
      services: payload.services,
      total: payload.total,
      depositDue: payload.depositDue,
      balanceDue: payload.balanceDue,
      shareUrl: QUOTE_LINK_AI_PLACEHOLDER,
      expiresAtIso: expiresIso,
      notes: payload.notes,
      reason: "sent",
    });
    generated = materializeGeneratedQuoteCopy(generatedDraft, payload.shareUrl);
  } catch (error) {
    console.warn("[notify] quote.ai.error", {
      quoteId: payload.quoteId,
      error: String(error),
    });
  }

  if (payload.contact.phone) {
    const smsBody =
      generated?.smsBody && generated.smsBody.length <= 240
        ? generated.smsBody
        : fallbackSms;
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "sms",
        toAddress: payload.contact.phone,
        body: smsBody,
        metadata: {
          kind: "quote.sent",
          quoteId: payload.quoteId,
          sendAttemptId: payload.sendAttemptId,
        },
        dedupeKey: quoteSentMessageDedupeKey(
          payload.quoteId,
          payload.sendAttemptId,
          "sms",
        ),
      });
    } else {
      await sendSms(payload.contact.phone, smsBody, {
        quoteId: payload.quoteId,
        type: "quote.sent",
      });
    }
  }

  const emailSubject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const emailBody =
    generated?.emailBody && generated.emailBody.length <= 900
      ? generated.emailBody
      : fallbackBody;

  if (payload.contact.email && payload.contactId) {
    await queueSystemOutboundMessage({
      contactId: payload.contactId,
      channel: "email",
      toAddress: payload.contact.email,
      subject: emailSubject,
      body: emailBody,
      metadata: {
        kind: "quote.sent",
        quoteId: payload.quoteId,
        sendAttemptId: payload.sendAttemptId,
      },
      dedupeKey: quoteSentMessageDedupeKey(
        payload.quoteId,
        payload.sendAttemptId,
        "email",
      ),
    });
  } else {
    await sendPlainEmail(payload.contact.email, emailSubject, emailBody, {
      quoteId: payload.quoteId,
      type: "quote.sent",
    });
  }

  const alertRecipients = getQuoteAlertRecipients();
  if (alertRecipients.length) {
    const subject = `Quote sent: ${servicesSummary(payload.services)} for ${payload.contact.name}`;
    const body = [
      `Customer: ${payload.contact.name}`,
      `Services: ${servicesSummary(payload.services)}`,
      `Total: ${formatCurrency(payload.total)}`,
      paymentTerms,
      `Quote ID: ${payload.quoteId}`,
      expiresIso ? `Expires: ${expiresIso}` : null,
      payload.notes ? `Notes: ${payload.notes}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await Promise.all(
      alertRecipients.map((recipient) =>
        sendPlainEmail(recipient, subject, body, {
          quoteId: payload.quoteId,
          type: "quote.sent",
          internal: true,
        }),
      ),
    );
  }
}

export async function sendQuoteDecisionNotification(
  payload: QuoteNotificationPayload & {
    decision: "accepted" | "declined";
    source: "customer";
  },
): Promise<void> {
  const paymentTerms =
    payload.depositDue > 0
      ? `Deposit listed on quote: ${formatCurrency(payload.depositDue)}. Balance due after service: ${formatCurrency(payload.balanceDue)}.`
      : "No deposit is required; payment will be collected after service.";
  const fallbackSubject =
    payload.decision === "accepted"
      ? "Stonegate quote approved"
      : "Stonegate quote decision received";
  const fallbackBody = [
    `Hi ${payload.contact.name},`,
    "",
    payload.decision === "accepted"
      ? "Thanks for approving your quote! We'll reach out to lock in the service window."
      : "We've recorded your decision. If you'd like revisions or have questions, we're happy to help.",
    `Services: ${joinServiceLabels(payload.services)}`,
    `Total: ${formatCurrency(payload.total)}.`,
    paymentTerms,
    `Quote link: ${payload.shareUrl}`,
    payload.notes ? `Notes: ${payload.notes}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms =
    payload.decision === "accepted"
      ? "Stonegate: thanks for approving your quote! We'll follow up with scheduling details."
      : "Stonegate: we've recorded your quote decision. Let us know if you'd like any adjustments.";

  let generated: GeneratedQuoteCopy | null = null;
  try {
    const generatedDraft = await generateQuoteNotificationCopy({
      customerName: payload.contact.name,
      services: payload.services,
      total: payload.total,
      depositDue: payload.depositDue,
      balanceDue: payload.balanceDue,
      shareUrl: QUOTE_LINK_AI_PLACEHOLDER,
      notes: payload.notes,
      reason: payload.decision,
    });
    generated = materializeGeneratedQuoteCopy(generatedDraft, payload.shareUrl);
  } catch (error) {
    console.warn("[notify] quote.decision.ai.error", {
      quoteId: payload.quoteId,
      decision: payload.decision,
      error: String(error),
    });
  }

  if (payload.contact.phone) {
    const smsBody =
      generated?.smsBody && generated.smsBody.length <= 240
        ? generated.smsBody
        : fallbackSms;
    if (payload.contactId) {
      await queueSystemOutboundMessage({
        contactId: payload.contactId,
        channel: "sms",
        toAddress: payload.contact.phone,
        body: smsBody,
        metadata: {
          kind: "quote.decision",
          quoteId: payload.quoteId,
          decision: payload.decision,
          source: payload.source,
        },
        dedupeKey: `quote.decision:${payload.quoteId}:${payload.decision}:${payload.source}`,
      });
    } else {
      await sendSms(payload.contact.phone, smsBody, {
        quoteId: payload.quoteId,
        type: "quote.decision",
        decision: payload.decision,
        source: payload.source,
      });
    }
  }

  const emailSubject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const emailBody =
    generated?.emailBody && generated.emailBody.length <= 900
      ? generated.emailBody
      : fallbackBody;

  if (payload.contact.email && payload.contactId) {
    await queueSystemOutboundMessage({
      contactId: payload.contactId,
      channel: "email",
      toAddress: payload.contact.email,
      subject: emailSubject,
      body: emailBody,
      metadata: {
        kind: "quote.decision",
        quoteId: payload.quoteId,
        decision: payload.decision,
        source: payload.source,
      },
      dedupeKey: `quote.decision:${payload.quoteId}:${payload.decision}:${payload.source}:email`,
    });
  } else {
    await sendPlainEmail(payload.contact.email, emailSubject, emailBody, {
      quoteId: payload.quoteId,
      type: "quote.decision",
      decision: payload.decision,
      source: payload.source,
    });
  }

  const alertRecipients = getQuoteAlertRecipients();
  if (alertRecipients.length) {
    const subject = `Quote ${payload.decision}: ${payload.contact.name}`;
    const body = [
      `Customer: ${payload.contact.name}`,
      `Services: ${servicesSummary(payload.services)}`,
      `Decision: ${payload.decision.toUpperCase()} (source: ${payload.source})`,
      `Total: ${formatCurrency(payload.total)}`,
      paymentTerms,
      `Quote ID: ${payload.quoteId}`,
      payload.notes ? `Notes: ${payload.notes}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await Promise.all(
      alertRecipients.map((recipient) =>
        sendPlainEmail(recipient, subject, body, {
          quoteId: payload.quoteId,
          type: "quote.decision",
          decision: payload.decision,
          source: payload.source,
          internal: true,
        }),
      ),
    );
  }
}
