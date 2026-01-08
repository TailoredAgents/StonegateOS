import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { generateEstimateNotificationCopy, generateQuoteNotificationCopy } from "@/lib/ai";
import { joinServiceLabels, summarizeServiceLabels } from "@/lib/service-labels";

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

const DEFAULT_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ??
  process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
  "America/New_York";

const SITE_URL =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "http://localhost:3000";

let cachedTransporter: nodemailer.Transporter | null;

function getTransport(): nodemailer.Transporter | null {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const host = process.env["SMTP_HOST"];
  const port = process.env["SMTP_PORT"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  if (!host || !port || !user || !pass) {
    return null;
  }

  const parsedPort = Number(port);
  const secure = parsedPort === 465;

  cachedTransporter = nodemailer.createTransport({
    host,
    port: parsedPort,
    secure,
    auth: {
      user,
      pass
    }
  });

  return cachedTransporter;
}

function formatDateTime(date: Date | null): string {
  if (!date) {
    return "TBD";
  }

  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone(DEFAULT_TIME_ZONE)
    .toLocaleString(DateTime.DATETIME_MED);
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
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
    appointment.rescheduleUrl ? `Reschedule: ${appointment.rescheduleUrl}` : null
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
    "END:VCALENDAR"
  ].join("\r\n");

  return {
    filename: "stonegate-appointment.ics",
    content,
    contentType: "text/calendar; charset=utf-8; method=REQUEST"
  };
}

async function sendSms(to: string, body: string, context: Record<string, unknown>): Promise<void> {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_FROM"];

  if (!sid || !token || !from) {
    console.info("[notify] sms.unsent.no_twilio", { to, body, ...context });
    return;
  }

  const twilioBaseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const form = new URLSearchParams({ From: from, To: to, Body: body }).toString();

    const response = await fetch(`${twilioBaseUrl}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`
      },
      body: form
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[notify] sms.failed", { to, status: response.status, text, ...context });
    } else {
      console.info("[notify] sms.sent", { to, ...context });
    }
  } catch (error) {
    console.warn("[notify] sms.error", { to, error: String(error), ...context });
  }
}

async function sendEmail(
  payload: EstimateNotificationPayload,
  subject: string,
  textBody: string
): Promise<void> {
  const transporter = getTransport();
  const from = process.env["SMTP_FROM"];
  const to = payload.contact.email;

  if (!transporter || !from || !to) {
    console.info("[notify] email.unsent", { subject, to: to ?? "unknown" });
    return;
  }

  const ics = createIcsAttachment(payload);
  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text: textBody,
      attachments: ics ? [ics] : undefined
    });
    console.info("[notify] email.sent", { to, subject });
  } catch (error) {
    console.warn("[notify] email.error", { to, subject, error: String(error) });
  }
}

async function sendPlainEmail(
  to: string | null | undefined,
  subject: string,
  textBody: string,
  context: Record<string, unknown>
): Promise<void> {
  const transporter = getTransport();
  const from = process.env["SMTP_FROM"];

  if (!transporter || !from || !to) {
    console.info("[notify] email.unsent", { ...context, subject, to: to ?? "unknown" });
    return;
  }

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text: textBody
    });
    console.info("[notify] email.sent", { ...context, to, subject });
  } catch (error) {
    console.warn("[notify] email.error", { ...context, to, subject, error: String(error) });
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
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

function buildRescheduleUrl(appointment: EstimateNotificationPayload["appointment"]): string {
  if (appointment.rescheduleUrl) {
    return appointment.rescheduleUrl;
  }

  const url = new URL("/schedule", SITE_URL);
  url.searchParams.set("appointmentId", appointment.id);
  url.searchParams.set("token", appointment.rescheduleToken);
  return url.toString();
}

function joinServices(services: string[]): string {
  return joinServiceLabels(services);
}

export async function sendEstimateConfirmation(
  payload: EstimateNotificationPayload,
  reason: ConfirmationReason = "requested"
): Promise<void> {
  const { contact, appointment, property, scheduling } = payload;
  const when = formatDateTime(appointment.startAt);
  const rescheduleUrl = buildRescheduleUrl(appointment);
  const headline = reason === "requested" ? "You're booked!" : "Appointment updated";

  const fallbackSubject = `Stonegate Junk Removal - ${when}`;
  const fallbackBody = [
    `${headline} We'll see you ${when}.`,
    `Location: ${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
    `Services: ${joinServices(payload.services)}`,
    scheduling.timeWindow ? `Preferred window: ${scheduling.timeWindow}` : null,
    payload.notes ? `Notes: ${payload.notes}` : null,
    "",
    `Need to reschedule? ${rescheduleUrl}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms =
    reason === "requested"
      ? `Stonegate confirm: appointment on ${when}. Need to adjust? ${rescheduleUrl}`
      : `Stonegate update: new appointment time ${when}. Need changes? ${rescheduleUrl}`;

  let generated = null;
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
        postalCode: property.postalCode
      },
      contactName: contact.name
    });
  } catch (error) {
    console.warn("[notify] ai.copy.error", { error: String(error) });
  }

  if (contact.phone) {
    const smsBody = generated?.smsBody && generated.smsBody.length <= 320 ? generated.smsBody : fallbackSms;
    await sendSms(contact.phone, smsBody, { leadId: payload.leadId, appointmentId: appointment.id });
  }

  await sendEmail(
    payload,
    generated?.emailSubject && generated.emailSubject.length <= 120 ? generated.emailSubject : fallbackSubject,
    generated?.emailBody && generated.emailBody.length <= 1000 ? generated.emailBody : fallbackBody
  );
}

interface ReminderOptions {
  windowMinutes: number;
}

async function sendEstimateReminderInternal(
  payload: EstimateNotificationPayload,
  options: ReminderOptions
): Promise<void> {
  const { contact, appointment } = payload;
  const when = formatDateTime(appointment.startAt);
  const rescheduleUrl = buildRescheduleUrl(appointment);
  const windowHours = Math.round(options.windowMinutes / 60);

  const fallbackSms = `Stonegate reminder: appointment in ${windowHours}h (${when}). Need to reschedule? ${rescheduleUrl}`;
  const fallbackEmailBody = [
    `Quick reminder: your Stonegate Junk Removal appointment is in ${windowHours} hours (${when}).`,
    `Location: ${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
    "",
    `Need to adjust? ${rescheduleUrl}`
  ].join("\n");
  const fallbackSubject = `Reminder: Stonegate appointment ${when}`;

  let generated = null;
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
        postalCode: payload.property.postalCode
      },
      contactName: payload.contact.name
    });
  } catch (error) {
    console.warn("[notify] reminder.ai.error", { error: String(error) });
  }

  if (contact.phone) {
    const smsBody = generated?.smsBody && generated.smsBody.length <= 320 ? generated.smsBody : fallbackSms;
    await sendSms(contact.phone, smsBody, {
      leadId: payload.leadId,
      appointmentId: appointment.id,
      reminderMinutes: options.windowMinutes
    });
  }

  const transporter = getTransport();
  const from = process.env["SMTP_FROM"];
  const to = payload.contact.email;

  if (transporter && from && to) {
    const subject =
      generated?.emailSubject && generated.emailSubject.length <= 120 ? generated.emailSubject : fallbackSubject;
    const text = generated?.emailBody && generated.emailBody.length <= 1000 ? generated.emailBody : fallbackEmailBody;

    try {
      await transporter.sendMail({ from, to, subject, text });
      console.info("[notify] email.reminder.sent", {
        to,
        appointmentId: appointment.id,
        reminderMinutes: options.windowMinutes
      });
    } catch (error) {
      console.warn("[notify] email.reminder.error", {
        to,
        appointmentId: appointment.id,
        reminderMinutes: options.windowMinutes,
        error: String(error)
      });
    }
  } else {
    console.info("[notify] reminder.email.unsent", {
      appointmentId: appointment.id,
      reminderMinutes: options.windowMinutes
    });
  }
}

export async function sendEstimateReminder(
  payload: EstimateNotificationPayload,
  windowMinutes: number
): Promise<void> {
  await sendEstimateReminderInternal(payload, { windowMinutes });
}

export async function sendEstimateReminder24h(payload: EstimateNotificationPayload): Promise<void> {
  await sendEstimateReminder(payload, 24 * 60);
}

export async function sendEstimateReminder2h(payload: EstimateNotificationPayload): Promise<void> {
  await sendEstimateReminder(payload, 2 * 60);
}

export async function sendQuoteSentNotification(payload: QuoteNotificationPayload): Promise<void> {
  const expiresIso = payload.expiresAt ? payload.expiresAt.toISOString() : null;

  const fallbackSubject = "Your Stonegate Junk Removal quote is ready";
  const fallbackBody = [
    `Hi ${payload.contact.name},`,
    "",
    `Your quote for ${joinServiceLabels(payload.services)} is ready.`,
    `Total: ${formatCurrency(payload.total)}.`,
    "No deposit is required; payment is due after the work is complete.",
    `Review and approve: ${payload.shareUrl}`,
    expiresIso ? `Expires: ${expiresIso}` : null,
    "",
    "We appreciate the opportunity to help."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms = `Stonegate quote ready: ${formatCurrency(payload.total)}. Review ${payload.shareUrl}`;

  let generated = null;
  try {
    generated = await generateQuoteNotificationCopy({
      customerName: payload.contact.name,
      services: payload.services,
      total: payload.total,
      depositDue: payload.depositDue,
      balanceDue: payload.balanceDue,
      shareUrl: payload.shareUrl,
      expiresAtIso: expiresIso,
      notes: payload.notes,
      reason: "sent"
    });
  } catch (error) {
    console.warn("[notify] quote.ai.error", { quoteId: payload.quoteId, error: String(error) });
  }

  if (payload.contact.phone) {
    const smsBody =
      generated?.smsBody && generated.smsBody.length <= 240 ? generated.smsBody : fallbackSms;
    await sendSms(payload.contact.phone, smsBody, {
      quoteId: payload.quoteId,
      type: "quote.sent"
    });
  }

  const emailSubject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const emailBody =
    generated?.emailBody && generated.emailBody.length <= 900 ? generated.emailBody : fallbackBody;

  await sendPlainEmail(payload.contact.email, emailSubject, emailBody, {
    quoteId: payload.quoteId,
    type: "quote.sent"
  });

  const alertRecipients = getQuoteAlertRecipients();
  if (alertRecipients.length) {
    const subject = `Quote sent: ${servicesSummary(payload.services)} for ${payload.contact.name}`;
  const body = [
    `Customer: ${payload.contact.name}`,
    `Services: ${servicesSummary(payload.services)}`,
    `Total: ${formatCurrency(payload.total)} (no deposit required)`,
    `Share link: ${payload.shareUrl}`,
    expiresIso ? `Expires: ${expiresIso}` : null,
    payload.notes ? `Notes: ${payload.notes}` : null
  ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await Promise.all(
      alertRecipients.map((recipient) =>
        sendPlainEmail(recipient, subject, body, {
          quoteId: payload.quoteId,
          type: "quote.sent",
          internal: true
        })
      )
    );
  }
}

export async function sendQuoteDecisionNotification(
  payload: QuoteNotificationPayload & { decision: "accepted" | "declined"; source: "customer" | "admin" }
): Promise<void> {
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
    "No deposit is required; payment will be collected after service.",
    `Quote link: ${payload.shareUrl}`,
    payload.notes ? `Notes: ${payload.notes}` : null
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const fallbackSms =
    payload.decision === "accepted"
      ? "Stonegate: thanks for approving your quote! We'll follow up with scheduling details."
      : "Stonegate: we've recorded your quote decision. Let us know if you'd like any adjustments.";

  let generated = null;
  try {
    generated = await generateQuoteNotificationCopy({
      customerName: payload.contact.name,
      services: payload.services,
      total: payload.total,
      depositDue: payload.depositDue,
      balanceDue: payload.balanceDue,
      shareUrl: payload.shareUrl,
      notes: payload.notes,
      reason: payload.decision
    });
  } catch (error) {
    console.warn("[notify] quote.decision.ai.error", {
      quoteId: payload.quoteId,
      decision: payload.decision,
      error: String(error)
    });
  }

  if (payload.contact.phone) {
    const smsBody =
      generated?.smsBody && generated.smsBody.length <= 240 ? generated.smsBody : fallbackSms;
    await sendSms(payload.contact.phone, smsBody, {
      quoteId: payload.quoteId,
      type: "quote.decision",
      decision: payload.decision,
      source: payload.source
    });
  }

  const emailSubject =
    generated?.emailSubject && generated.emailSubject.length <= 120
      ? generated.emailSubject
      : fallbackSubject;
  const emailBody =
    generated?.emailBody && generated.emailBody.length <= 900 ? generated.emailBody : fallbackBody;

  await sendPlainEmail(payload.contact.email, emailSubject, emailBody, {
    quoteId: payload.quoteId,
    type: "quote.decision",
    decision: payload.decision,
    source: payload.source
  });

  const alertRecipients = getQuoteAlertRecipients();
  if (alertRecipients.length) {
    const subject = `Quote ${payload.decision}: ${payload.contact.name}`;
  const body = [
    `Customer: ${payload.contact.name}`,
    `Services: ${servicesSummary(payload.services)}`,
    `Decision: ${payload.decision.toUpperCase()} (source: ${payload.source})`,
    `Total: ${formatCurrency(payload.total)} (no deposit required)`,
    `Quote link: ${payload.shareUrl}`,
    payload.notes ? `Notes: ${payload.notes}` : null
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
          internal: true
        })
      )
    );
  }
}
