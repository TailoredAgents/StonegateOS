import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { DateTime } from "luxon";
import { resolveMetaGraphApiEndpoint } from "@myst-os/sdk";
import {
  getDb,
  outboxEvents,
  callCoaching,
  appointments,
  automationSettings,
  leads,
  instantQuotes,
  contacts,
  crmTasks,
  properties,
  quotes,
  crmPipeline,
  auditLogs,
  teamMembers,
  conversationParticipants,
  conversationMessages,
  conversationThreads,
  leadAutomationStates,
  messageDeliveryEvents,
  appointmentTasks,
  partnerBookings,
  partnerJobEvents,
} from "@/db";
import {
  getBusinessHoursPolicy,
  getConfirmationLoopPolicy,
  getCompanyProfilePolicy,
  getFollowUpSequencePolicy,
  getInboxAlertsPolicy,
  getQuietHoursPolicy,
  getReviewRequestPolicy,
  getSalesAutopilotPolicy,
  getServiceAreaPolicy,
  getTemplatesPolicy,
  isCityAllowed,
  nextQuietHoursEnd,
  resolveTemplateForChannel,
} from "@/lib/policy";
import { analyzeCallTranscript, transcribeAudio } from "@/lib/call-analysis";
import { scoreCallTranscript } from "@/lib/call-coaching";
import {
  deleteTwilioRecording,
  downloadTwilioRecordingAudio,
  listTwilioRecordingsForCall,
} from "@/lib/twilio-recordings";
import { createTwilioOutboundCall } from "@/lib/twilio-calls";
import type {
  EstimateNotificationPayload,
  QuoteNotificationPayload,
} from "@/lib/notifications";
import {
  sendEstimateCancellation,
  sendEstimateConfirmation,
  sendEstimateReminder,
  sendQuoteSentNotification,
  sendQuoteDecisionNotification,
} from "@/lib/notifications";
import type { AppointmentCalendarPayload } from "@/lib/calendar";
import {
  buildGoogleCalendarEventId,
  deleteCalendarEvent,
} from "@/lib/calendar";
import {
  createCalendarEventWithRetry,
  updateCalendarEventWithRetry,
} from "@/lib/calendar-events";
import {
  sendDmMessage,
  sendDmTyping,
  sendEmailMessage,
  sendSmsMessage,
} from "@/lib/messaging";
import {
  buildContactTag,
  buildLeadTag,
  getSalesScorecardConfig,
} from "@/lib/sales-scorecard";
import { handleInboundAutoReply } from "@/lib/auto-replies";
import {
  handleInboundSalesAutopilot,
  handleSalesAutopilotAutosend,
} from "@/lib/sales-autopilot";
import { handleFacebookSalesEvaluate } from "@/lib/facebook-sales-autopilot";
import { recordAuditEvent } from "@/lib/audit";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import {
  AppointmentMediaError,
  importAppointmentRelatedMedia,
  importConversationMessageMedia,
} from "@/lib/appointment-media";
import { isMediaAutoImportEnabled } from "@/lib/feature-flags";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";
import {
  MetaGraphApiError,
  syncMetaAdsInsightsDaily,
} from "@/lib/meta-ads-insights";
import {
  GoogleAdsApiError,
  syncGoogleAdsInsightsDaily,
} from "@/lib/google-ads-insights";
import { runGoogleAdsAnalystReport } from "@/lib/google-ads-analyst";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import {
  fetchFacebookLeadgenDetails,
  fetchFacebookSenderName,
  recordLeadFromFacebook,
} from "@/lib/facebook-webhooks";
import { recordInboundMessage } from "@/lib/inbox";
import {
  planContactScopedOutboxReconciliation,
  planOutboxOutcomeFinalization,
  type OutboxFinalizationOutcome,
} from "@/lib/outbox-finalization";
import {
  APPOINTMENT_MEDIA_MAX_ATTEMPTS,
  GOOGLE_ADS_SYNC_MAX_ATTEMPTS,
  isGoogleAdsInvalidResponseFailure,
} from "@/lib/outbox-poison-policy";
import {
  claimMessageDispatch,
  ensureMessageDispatchRequested,
  finalizeMessageDispatch,
  type ExternalMessageChannel,
} from "@/lib/external-message-dispatch";
import {
  parseQuoteDecisionOutboxPayload,
  resolveQuoteSendAttemptId,
  shouldNotifyCustomerForQuoteDecision,
} from "@/lib/quote-outbox-contract";
import { isQuoteEventType } from "@/lib/quote-v2-outbox-contract";
import { processQuoteV2SendRequestedOutbox } from "@/lib/quote-v2-send-worker";
import { processQuoteV2WorkflowOutbox } from "@/lib/quote-v2-outbox-worker";
import { canAutomaticallyTransitionPipeline } from "@/lib/pipeline-monotonicity";
import { resolveUsableQuoteDeliveryChannels } from "@/lib/contact-outbound-safety";
import {
  buildTwilioWebhookUrl,
  getTwilioWebhookPublicBaseUrl,
} from "@/lib/twilio-webhook-auth";
import { buildLegacyOutboxProviderRequestKey } from "@/lib/outbox-provider-request-key";
import { processExpenseReceiptAnalysisOutbox } from "@/lib/expense-receipt-captures";
import {
  finalizeSalesEscalationCallAttempt,
  prepareSalesEscalationCallAttempt,
  reconcileSalesEscalationAfterStorageFailure,
  resumeSalesEscalationCallAttempt,
} from "@/lib/sales-escalation-call-operations";
import {
  claimRecordingProcessingLease,
  deferRecordingProcessingLease,
  finalizeRecordingDelete,
  persistAnalyzedRecording,
  persistSkippedRecordingProcessing,
  prepareRecordingDelete,
  quarantineRecordingDeleteEvent,
  recordVerifiedEmptyRecordingPoll,
} from "@/lib/call-recording-persistence";
import {
  getTeamOperationKillSwitch,
  getTeamOperationKillSwitchForRisk,
} from "@/lib/team-operation-kill-switch";
import { getOutboxDispatchBlock } from "@/lib/outbox-dispatch-policy";
import {
  finalizeStaffNotificationDispatch,
  prepareStaffNotificationDispatch,
} from "@/lib/staff-notification-operations";
import { processPartnerAccountInvitationEmail } from "@/lib/partner-account-invitation-delivery";

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

type OutboxOutcome = OutboxFinalizationOutcome & {
  /** The dispatch state machine already deferred or quarantined this event. */
  skipFinalization?: boolean;
};

class ContactDispatchGuardFailure extends Error {
  constructor(cause: unknown) {
    super(`contact_dispatch_guard_failed:${String(cause)}`);
    this.name = "ContactDispatchGuardFailure";
  }
}

class OutboxFinalizationFailure extends Error {
  constructor(cause: unknown) {
    super(`outbox_finalization_failed:${String(cause)}`);
    this.name = "OutboxFinalizationFailure";
  }
}

const MAX_MESSAGE_SEND_ATTEMPTS = 3;
const CONTACT_MESSAGE_ENQUEUE_EVENT_TYPES = new Set([
  "estimate.requested",
  "estimate.rescheduled",
  "estimate.status_changed",
  "estimate.reminder",
  "lead.created",
  "review.request",
  "quote.sent",
  "quote.decision",
  // Quote V2 uses an encrypted per-delivery ledger and pre-dispatch markers;
  // it must own provider calls outside the contact-scoped transaction.
  "quote.send_requested.v2",
  // Quote V2 workflow handlers own idempotent activity checkpoints. The
  // accepted/booked handler also queues a deduplicated customer message using
  // its own contact lock, so these must not nest under the generic lock.
  "quote.change_requested.v2",
  "quote.response_recorded.v2",
  "quote.deposit_checkout_requested.v2",
  "quote.accepted_and_booked.v2",
  // This handler owns a separate durable provider ledger and must not execute
  // inside the contact-scoped transaction that surrounds ordinary handlers.
  "sales.escalation.call",
  // Recording processing performs provider/model work before one atomic local
  // commit and acquires the same contact advisory lock inside that commit.
  // Nesting it under the outer contact lock would deadlock across connections.
  "call.recording.process",
  // Staff alerts have their own pre-dispatch state and uncertainty ledger.
  // They must not run inside the ordinary contact-scoped transaction.
  "staff_notification.dispatch",
]);
const HUMANISTIC_DELAY_MIN_MS = 10_000;
const HUMANISTIC_DELAY_MAX_MS = 30_000;
const AUTO_FIRST_TOUCH_SMS_ENABLED =
  process.env["SALES_AUTO_FIRST_TOUCH_SMS_ENABLED"] !== "0";
const SALES_ESCALATION_CALL_ENABLED =
  process.env["SALES_ESCALATION_CALL_ENABLED"] !== "0";
const SPEED_TO_LEAD_SLA_SMS_ENABLED =
  process.env["SPEED_TO_LEAD_SLA_SMS_ENABLED"] === "1";

const APPOINTMENT_STATUS_VALUES = [
  "requested",
  "confirmed",
  "completed",
  "no_show",
  "canceled",
] as const;
type AppointmentStatus = (typeof APPOINTMENT_STATUS_VALUES)[number];
const VALID_APPOINTMENT_STATUSES = new Set<string>(APPOINTMENT_STATUS_VALUES);

type PipelineStage =
  | "new"
  | "contacted"
  | "quoted"
  | "in_person_quote"
  | "qualified"
  | "won"
  | "lost";
const PIPELINE_STAGE_SET = new Set<PipelineStage>([
  "new",
  "contacted",
  "quoted",
  "in_person_quote",
  "qualified",
  "won",
  "lost",
]);

type FollowUpChannel = "sms" | "email";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === "string" && VALID_APPOINTMENT_STATUSES.has(value);
}

function outcomeForOutboxHandlerError(
  event: Pick<OutboxEventRecord, "attempts" | "id" | "type">,
  error: unknown,
): OutboxOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const attempt = (event.attempts ?? 0) + 1;
  const canRetry =
    (event.type === "message.send" && attempt < MAX_MESSAGE_SEND_ATTEMPTS) ||
    // Dedicated provider-operation ledgers, not the generic outbox counter,
    // own bounded attempts and no-repeat decisions. Retrying an unexpected
    // handler/storage exception is safe: a pre-dispatch failure can resume,
    // while a committed `dispatched` marker becomes reconciliation work
    // before the provider could be called again.
    event.type === "sales.escalation.call" ||
    event.type === "staff_notification.dispatch" ||
    event.type === "partner.account_invitation.email" ||
    // Calendar creates use a deterministic provider ID, while updates always
    // target the already-persisted ID. Both operations therefore converge on
    // retry instead of treating an ambiguous provider response as success.
    event.type === "appointment.calendar_sync_requested" ||
    // Receipt analysis owns its terminal attempt budget on the capture row.
    // Infrastructure failures before that state can be persisted must remain
    // retryable or a queued/polling client would be orphaned permanently.
    event.type === "expense.receipt.analyze" ||
    (event.type.startsWith("facebook.") && attempt < 5) ||
    (isQuoteEventType(event.type) && attempt < 8) ||
    event.type.startsWith("call.recording.");
  console.warn("[outbox] handler_error", {
    id: event.id,
    type: event.type,
    error: message,
  });
  const exhaustedHandlerBudget =
    event.type === "message.send" || event.type.startsWith("facebook.");
  return canRetry
    ? { status: "retry", error: message }
    : {
        status: "quarantined",
        error: message,
        quarantineReason: exhaustedHandlerBudget
          ? "outbox_handler_retry_budget_exhausted"
          : "outbox_handler_error_terminal",
      };
}

async function finalizeOutboxEvent(
  db: Pick<ReturnType<typeof getDb>, "update">,
  event: OutboxEventRecord,
  outcome: OutboxOutcome,
  now = new Date(),
): Promise<void> {
  const [finalized] = await db
    .update(outboxEvents)
    .set(planOutboxOutcomeFinalization(event, outcome, now))
    .where(
      and(
        eq(outboxEvents.id, event.id),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
      ),
    )
    .returning({ id: outboxEvents.id });
  if (!finalized?.id) {
    throw new OutboxFinalizationFailure("event_not_dispatchable");
  }
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
    normalized.includes("unsupported_channel") ||
    normalized.includes("email_request_invalid") ||
    normalized.includes("email_rejected:permanent")
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

async function recordProviderSuccessSafe(
  provider:
    | "sms"
    | "email"
    | "calendar"
    | "meta_ads"
    | "google_ads"
    | "google_ads_analyst",
): Promise<void> {
  try {
    await recordProviderSuccess(provider);
  } catch (error) {
    console.warn("[provider] health_success_failed", {
      provider,
      error: String(error),
    });
  }
}

async function recordProviderFailureSafe(
  provider:
    | "sms"
    | "email"
    | "calendar"
    | "meta_ads"
    | "google_ads"
    | "google_ads_analyst",
  detail: string | null,
): Promise<void> {
  try {
    await recordProviderFailure(provider, detail ?? null);
  } catch (error) {
    console.warn("[provider] health_failure_failed", {
      provider,
      error: String(error),
    });
  }
}

function coerceServices(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function randomHumanisticDelayMs(): number {
  return (
    Math.floor(
      Math.random() * (HUMANISTIC_DELAY_MAX_MS - HUMANISTIC_DELAY_MIN_MS + 1),
    ) + HUMANISTIC_DELAY_MIN_MS
  );
}

function readMetaNumber(
  metadata: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type AppointmentCustomerMessageIntent =
  | "status_notification"
  | "review_request";
type AppointmentMessageAuthorizationEvidence = {
  auditEventId: string;
  actorId: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
  correlationId: string;
  operationId: string;
  requiredPermission: "messages.send";
};
type AppointmentMessageAuthorization =
  | { state: "not_requested" | "invalid"; evidence: null }
  | {
      state: "authorized";
      evidence: AppointmentMessageAuthorizationEvidence;
    };

const UUID_VALUE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Customer messaging from an appointment-status event is allowed only when
 * the committed status mutation explicitly requested that exact effect. The
 * outbox marker is not trusted on its own: it must resolve to the immutable
 * success audit row produced in the same database transaction.
 */
async function verifyAppointmentMessageAuthorization(input: {
  db: ReturnType<typeof getDb>;
  payload: Record<string, unknown> | null;
  appointmentId: string;
  status: string | null;
  intent: AppointmentCustomerMessageIntent;
  requested: boolean;
}): Promise<AppointmentMessageAuthorization> {
  if (!input.requested) return { state: "not_requested", evidence: null };
  const authorization =
    input.payload && isRecord(input.payload["messageAuthorization"])
      ? input.payload["messageAuthorization"]
      : null;
  const auditEventId = readStringValue(authorization?.["auditEventId"]);
  const actorId = readStringValue(authorization?.["actorId"]);
  const sessionId = readStringValue(authorization?.["sessionId"]);
  const authMethod = readStringValue(authorization?.["authMethod"]);
  const correlationId = readStringValue(authorization?.["correlationId"]);
  const operationId = readStringValue(authorization?.["operationId"]);
  const requiredPermission = readStringValue(
    authorization?.["requiredPermission"],
  );
  const payloadCorrelationId = readStringValue(
    input.payload?.["correlationId"],
  );
  const payloadVersion = readStringValue(input.payload?.["version"]);
  if (
    !auditEventId ||
    !UUID_VALUE_PATTERN.test(auditEventId) ||
    !actorId ||
    !sessionId ||
    (authMethod !== "team_session" && authMethod !== "break_glass") ||
    !correlationId ||
    correlationId !== payloadCorrelationId ||
    !operationId ||
    requiredPermission !== "messages.send" ||
    !payloadVersion
  ) {
    return { state: "invalid", evidence: null };
  }

  const [audit] = await input.db
    .select({
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      sessionId: auditLogs.sessionId,
      authMethod: auditLogs.authMethod,
      correlationId: auditLogs.correlationId,
      requiredPermissions: auditLogs.requiredPermissions,
      outcome: auditLogs.outcome,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      meta: auditLogs.meta,
    })
    .from(auditLogs)
    .where(eq(auditLogs.id, auditEventId))
    .limit(1);
  const meta = isRecord(audit?.meta) ? audit.meta : null;
  const after = meta && isRecord(meta["after"]) ? meta["after"] : null;
  const expectedIntentMetadata =
    input.intent === "status_notification"
      ? "customerNotificationRequested"
      : "reviewRequestRequested";
  const authorized =
    audit?.actorType === "human" &&
    audit.actorId === actorId &&
    audit.sessionId === sessionId &&
    audit.authMethod === authMethod &&
    audit.correlationId === correlationId &&
    audit.outcome === "succeeded" &&
    audit.action === "appointment.status.updated" &&
    audit.entityType === "appointment" &&
    audit.entityId === input.appointmentId &&
    Array.isArray(audit.requiredPermissions) &&
    audit.requiredPermissions.includes("messages.send") &&
    meta?.["operationId"] === operationId &&
    meta?.[expectedIntentMetadata] === true &&
    after?.["status"] === input.status &&
    after?.["version"] === payloadVersion;
  return authorized
    ? {
        state: "authorized",
        evidence: {
          auditEventId,
          actorId,
          sessionId,
          authMethod,
          correlationId,
          operationId,
          requiredPermission: "messages.send",
        },
      }
    : { state: "invalid", evidence: null };
}

async function verifyAppointmentCancellationCalendarAuthorization(input: {
  db: ReturnType<typeof getDb>;
  payload: Record<string, unknown>;
  appointmentId: string;
  requestedVersion: string;
  requestedCalendarEventId: string;
}): Promise<boolean> {
  const auditEventId = readStringValue(input.payload["sourceAuditEventId"]);
  const actorId = readStringValue(input.payload["actorId"]);
  const sessionId = readStringValue(input.payload["sessionId"]);
  const authMethod = readStringValue(input.payload["authMethod"]);
  const correlationId = readStringValue(input.payload["correlationId"]);
  const operationId = readStringValue(input.payload["operationId"]);
  const requiredPermission = readStringValue(
    input.payload["requiredPermission"],
  );
  const isTeamAuthorization =
    (authMethod === "team_session" || authMethod === "break_glass") &&
    requiredPermission === "appointments.update";
  const isPartnerAuthorization =
    authMethod === "partner_session" &&
    requiredPermission === "partner.bookings.cancel";
  if (
    !auditEventId ||
    !UUID_VALUE_PATTERN.test(auditEventId) ||
    !actorId ||
    !sessionId ||
    !correlationId ||
    !operationId ||
    (!isTeamAuthorization && !isPartnerAuthorization)
  ) {
    return false;
  }

  const [audit] = await input.db
    .select({
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      sessionId: auditLogs.sessionId,
      authMethod: auditLogs.authMethod,
      correlationId: auditLogs.correlationId,
      requiredPermissions: auditLogs.requiredPermissions,
      outcome: auditLogs.outcome,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      meta: auditLogs.meta,
    })
    .from(auditLogs)
    .where(eq(auditLogs.id, auditEventId))
    .limit(1);
  const meta = isRecord(audit?.meta) ? audit.meta : null;
  const before = meta && isRecord(meta["before"]) ? meta["before"] : null;
  const after = meta && isRecord(meta["after"]) ? meta["after"] : null;
  const commonEvidence = Boolean(
    audit?.actorType === "human" &&
      audit.actorId === actorId &&
      audit.sessionId === sessionId &&
      audit.authMethod === authMethod &&
      audit.correlationId === correlationId &&
      audit.outcome === "succeeded" &&
      audit.entityType === "appointment" &&
      audit.entityId === input.appointmentId &&
      Array.isArray(audit.requiredPermissions) &&
      audit.requiredPermissions.includes(requiredPermission) &&
      meta?.["operationId"] === operationId &&
      meta?.["calendarSync"] === "requested" &&
      before?.["calendarEventId"] === input.requestedCalendarEventId &&
      after?.["status"] === "canceled" &&
      after?.["version"] === input.requestedVersion,
  );
  if (!commonEvidence) return false;
  return isTeamAuthorization
    ? audit?.action === "appointment.status.updated"
    : audit?.action === "partner.booking.canceled";
}

/**
 * Resolve every currently supported CRM reference carried by an outbox
 * payload back to its contact and current deletion state. This runs
 * immediately before a handler, so provider calls do not rely only on the
 * delete-time scan.
 */
type OutboxContactScope = {
  contactId: string;
  deletedAt: Date | null;
};

async function resolveContactForOutboxEvent(
  event: OutboxEventRecord,
): Promise<OutboxContactScope | null> {
  const payload = isRecord(event.payload) ? event.payload : null;
  if (!payload) return null;

  const predicates: SQL<unknown>[] = [];
  const contactId = readStringValue(payload["contactId"]);
  if (contactId) {
    predicates.push(sql`${contacts.id}::text = ${contactId}`);
  }

  const leadId = readStringValue(payload["leadId"]);
  if (leadId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "leads" AS guarded_lead
      WHERE guarded_lead."contact_id" = ${contacts.id}
        AND guarded_lead."id"::text = ${leadId}
    )`);
  }

  const appointmentId = readStringValue(payload["appointmentId"]);
  if (appointmentId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "appointments" AS guarded_appointment
      WHERE guarded_appointment."contact_id" = ${contacts.id}
        AND guarded_appointment."id"::text = ${appointmentId}
    )`);
  }

  const quoteId = readStringValue(payload["quoteId"]);
  if (quoteId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "quotes" AS guarded_quote
      WHERE guarded_quote."contact_id" = ${contacts.id}
        AND guarded_quote."id"::text = ${quoteId}
    )`);
  }

  const taskId = readStringValue(payload["taskId"]);
  if (taskId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "crm_tasks" AS guarded_task
      WHERE guarded_task."contact_id" = ${contacts.id}
        AND guarded_task."id"::text = ${taskId}
    )`);
  }

  const threadId = readStringValue(payload["threadId"]);
  if (threadId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "conversation_threads" AS guarded_thread
      WHERE guarded_thread."contact_id" = ${contacts.id}
        AND guarded_thread."id"::text = ${threadId}
    )`);
  }

  for (const messageKey of [
    "messageId",
    "draftMessageId",
    "inboundMessageId",
  ] as const) {
    const messageId = readStringValue(payload[messageKey]);
    if (!messageId) continue;
    predicates.push(sql`EXISTS (
      SELECT 1
      FROM "conversation_messages" AS guarded_message
      INNER JOIN "conversation_threads" AS guarded_message_thread
        ON guarded_message_thread."id" = guarded_message."thread_id"
      WHERE guarded_message_thread."contact_id" = ${contacts.id}
        AND guarded_message."id"::text = ${messageId}
    )`);
  }

  const callRecordId = readStringValue(payload["callRecordId"]);
  const callSid = readStringValue(payload["callSid"]);
  if (callRecordId || callSid) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM "call_records" AS guarded_call
      WHERE guarded_call."contact_id" = ${contacts.id}
        AND (
          guarded_call."id"::text = ${callRecordId}
          OR guarded_call."call_sid" = ${callSid}
        )
    )`);
  }

  if (predicates.length === 0) return null;
  const [contact] = await getDb()
    .select({ id: contacts.id, deletedAt: contacts.deletedAt })
    .from(contacts)
    .where(or(...predicates))
    .limit(1);

  return contact
    ? { contactId: contact.id, deletedAt: contact.deletedAt }
    : null;
}

async function quarantineOutboxEventForDeletedContact(
  event: OutboxEventRecord,
  contactId: string,
): Promise<void> {
  const db = getDb();
  const quarantinedAt = new Date();
  await db.transaction(async (tx) => {
    const [quarantined] = await tx
      .update(outboxEvents)
      .set({
        quarantinedAt,
        quarantinedBy: null,
        quarantineReason: "contact_soft_deleted",
        quarantinedContactId: contactId,
        lastError: "contact_soft_deleted",
      })
      .where(
        and(
          eq(outboxEvents.id, event.id),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
        ),
      )
      .returning({ id: outboxEvents.id });

    if (!quarantined?.id) return;
    await tx.insert(auditLogs).values({
      actorType: "worker",
      actorId: null,
      actorRole: null,
      actorLabel: "outbox",
      action: "contact.outbox_quarantined",
      entityType: "contact",
      entityId: contactId,
      meta: {
        outboxEventId: event.id,
        outboxEventType: event.type,
        reason: "contact_soft_deleted",
        outcome: "succeeded",
      },
      createdAt: quarantinedAt,
    });
  });
}

async function quarantineOutboxEventForFinalizationReconciliation(
  event: OutboxEventRecord,
  contactId: string,
  options: { writeAudit?: boolean } = {},
): Promise<"quarantined" | "already_terminal"> {
  const db = getDb();
  const quarantinedAt = new Date();
  return db.transaction(async (tx) => {
    // Reacquire the contact lock before changing terminal state. This closes
    // the ordinary worker race after the provider transaction rolls back,
    // while the durable provider-state-machine work remains the crash-safe
    // solution for a database outage or process death in this narrow window.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
    );
    const [quarantined] = await tx
      .update(outboxEvents)
      .set(
        planContactScopedOutboxReconciliation(event, contactId, quarantinedAt),
      )
      .where(
        and(
          eq(outboxEvents.id, event.id),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
        ),
      )
      .returning({ id: outboxEvents.id });

    if (!quarantined?.id) return "already_terminal";
    if (options.writeAudit !== false) {
      await tx.insert(auditLogs).values({
        actorType: "worker",
        actorId: null,
        actorRole: null,
        actorLabel: "outbox",
        action: "contact.outbox_reconciliation_required",
        entityType: "contact",
        entityId: contactId,
        meta: {
          outboxEventId: event.id,
          outboxEventType: event.type,
          reason: "provider_effect_finalization_uncertain",
          outcome: "reconciliation_required",
          redispatchPrevented: true,
        },
        createdAt: quarantinedAt,
      });
    }
    return "quarantined";
  });
}

async function handleContactScopedOutboxEvent(
  event: OutboxEventRecord,
  contactId: string,
): Promise<
  | { kind: "handled"; outcome: OutboxOutcome }
  | { kind: "deleted" }
  | { kind: "unavailable" }
> {
  const db = getDb();
  let handlerStarted = false;
  try {
    return await db.transaction(async (tx) => {
      // This lock is shared with contact DELETE. A handler that wins the lock
      // finishes all provider effects before deletion can commit; a deletion
      // that wins makes this recheck block the handler before any provider call.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
      const [dispatchableEvent] = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.id, event.id),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        )
        .limit(1);
      if (!dispatchableEvent?.id) return { kind: "unavailable" as const };

      const [contact] = await tx
        .select({ deletedAt: contacts.deletedAt })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (contact?.deletedAt) return { kind: "deleted" as const };

      handlerStarted = true;
      let outcome: OutboxOutcome;
      try {
        outcome = contact
          ? await handleOutboxEvent(event)
          : { status: "skipped", error: "contact_missing" };
      } catch (error) {
        outcome = outcomeForOutboxHandlerError(event, error);
      }
      try {
        await finalizeOutboxEvent(tx, event, outcome);
      } catch (error) {
        throw new OutboxFinalizationFailure(error);
      }
      return { kind: "handled" as const, outcome };
    });
  } catch (error) {
    if (error instanceof OutboxFinalizationFailure) throw error;
    if (!handlerStarted) throw new ContactDispatchGuardFailure(error);
    throw error;
  }
}

function readMetadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) return null;
  return readStringValue(metadata[key]);
}

function resolveDmProvider(
  metadata: Record<string, unknown> | null,
): string | null {
  return (
    readMetadataString(metadata, "dmProvider") ??
    readMetadataString(metadata, "source") ??
    readMetadataString(metadata, "provider") ??
    null
  );
}

function resolveDmPageId(
  metadata: Record<string, unknown> | null,
): string | null {
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
  updates: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...updates };
}

function readEmailAttachments(
  metadata: Record<string, unknown> | null,
):
  | Array<{ filename: string; content: string; contentType: string }>
  | null
  | undefined {
  const raw = metadata?.["emailAttachments"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length > 4) return null;
  const attachments = raw
    .map((value) => {
      if (!isRecord(value)) return null;
      const filename = readStringValue(value["filename"]);
      const content = readStringValue(value["content"]);
      const contentType = readStringValue(value["contentType"]);
      if (
        !filename ||
        !content ||
        !contentType ||
        filename.length > 160 ||
        content.length > 250_000 ||
        !/^text\/calendar(?:;|$)/iu.test(contentType)
      ) {
        return null;
      }
      return {
        filename: filename.replace(/[^a-z0-9._-]/giu, "_"),
        content,
        contentType,
      };
    })
    .filter(
      (
        value,
      ): value is {
        filename: string;
        content: string;
        contentType: string;
      } => value !== null,
    );
  if (attachments.length !== raw.length) return null;
  return attachments;
}

function isDmWebhookConfigured(): boolean {
  return Boolean(readStringValue(process.env["DM_WEBHOOK_URL"]));
}

function hasFacebookDmEnv(): boolean {
  return Boolean(
    readStringValue(process.env["FB_MESSENGER_ACCESS_TOKEN"]) ??
      readStringValue(process.env["FB_LEADGEN_ACCESS_TOKEN"]),
  );
}

async function resolveDmSendMetadata(
  db: ReturnType<typeof getDb>,
  threadId: string,
  metadata: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const provider = resolveDmProvider(metadata);
  const pageId =
    resolveDmPageId(metadata) ?? readStringValue(process.env["FB_PAGE_ID"]);

  if (provider && pageId) {
    return metadata;
  }

  const [latestInbound] = await db
    .select({
      provider: conversationMessages.provider,
      toAddress: conversationMessages.toAddress,
      metadata: conversationMessages.metadata,
      receivedAt: conversationMessages.receivedAt,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, threadId),
        eq(conversationMessages.channel, "dm"),
        eq(conversationMessages.direction, "inbound"),
      ),
    )
    .orderBy(
      desc(conversationMessages.receivedAt),
      desc(conversationMessages.createdAt),
    )
    .limit(1);

  const inboundMetadata = isRecord(latestInbound?.metadata)
    ? latestInbound.metadata
    : null;
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

  return Object.keys(updates).length === 0
    ? metadata
    : mergeMetadata(metadata, updates);
}

async function resolveDmRecipient(
  db: ReturnType<typeof getDb>,
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ externalAddress: conversationParticipants.externalAddress })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "contact"),
      ),
    )
    .limit(1);
  return typeof row?.externalAddress === "string" &&
    row.externalAddress.trim().length > 0
    ? row.externalAddress.trim()
    : null;
}

function normalizePhoneE164(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (trimmed.startsWith("+") && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

function normalizeSalesDueAt(dueAt: Date, timezone: string): Date {
  const local = DateTime.fromJSDate(dueAt, { zone: timezone });
  const start = local.set({ hour: 7, minute: 30, second: 0, millisecond: 0 });
  const end = local.set({ hour: 19, minute: 30, second: 0, millisecond: 0 });

  if (local < start) return start.toUTC().toJSDate();
  if (local > end) return start.plus({ days: 1 }).toUTC().toJSDate();
  return dueAt;
}

function resolveSalesClockStart(
  createdAt: Date,
  timezone: string,
): { clockStart: Date; isWithinBusinessHours: boolean } {
  const normalized = normalizeSalesDueAt(createdAt, timezone);
  return {
    clockStart: normalized,
    isWithinBusinessHours: normalized.getTime() === createdAt.getTime(),
  };
}

function nextSalesWindowStart(now: Date): Date | null {
  const local = DateTime.fromJSDate(now, { zone: "America/New_York" });
  const start = local.set({ hour: 7, minute: 30, second: 0, millisecond: 0 });
  const end = local.set({ hour: 19, minute: 30, second: 0, millisecond: 0 });

  if (local < start) return start.toUTC().toJSDate();
  if (local >= end) return start.plus({ days: 1 }).toUTC().toJSDate();
  return null;
}

function buildQuoteShareUrl(token: string): string | null {
  const base = resolvePublicSiteBaseUrl();
  if (!base) return null;
  return new URL(`/quote/${token}`, base).toString();
}

function buildRescheduleUrlForAppointment(
  appointmentId: string,
  token: string,
): string | null {
  const base = resolvePublicSiteBaseUrl();
  if (!base) return null;
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

async function getTeamMemberPhoneMap(
  db: ReturnType<typeof getDb>,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: teamMembers.id, phoneE164: teamMembers.phoneE164 })
    .from(teamMembers)
    .where(eq(teamMembers.active, true));
  return Object.fromEntries(
    rows.flatMap((row) => {
      const phoneE164 = row.phoneE164?.trim() ?? "";
      return /^\+[1-9][0-9]{9,14}$/u.test(phoneE164)
        ? [[row.id, phoneE164] as const]
        : [];
    }),
  );
}

function buildInboundInboxAlertText(input: {
  contactName: string | null;
  contactPhone: string | null;
  body: string;
  channel: string | null;
}): string {
  const name = input.contactName?.trim().length
    ? input.contactName.trim()
    : null;
  const phone = input.contactPhone?.trim().length
    ? input.contactPhone.trim()
    : null;
  const label =
    input.channel === "dm"
      ? "Messenger"
      : input.channel === "email"
        ? "email"
        : input.channel === "sms"
          ? "text"
          : "message";
  const header = name
    ? `New ${label} from ${name}`
    : phone
      ? `New ${label} from ${phone}`
      : `New ${label} in inbox`;
  const rawBody = input.body.trim().replace(/\s+/g, " ");
  const snippet =
    rawBody.length > 220 ? `${rawBody.slice(0, 217)}...` : rawBody;
  const phoneLine = name && phone ? ` (${phone})` : "";
  return `${header}${phoneLine}: ${snippet}`;
}

async function maybeNotifyAssigneeForInboundSmsMessage(input: {
  db: ReturnType<typeof getDb>;
  messageId: string;
}): Promise<void> {
  const [message] = await input.db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
      threadId: conversationMessages.threadId,
      contactId: conversationThreads.contactId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      assignedTo: contacts.salespersonMemberId,
    })
    .from(conversationMessages)
    .leftJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .where(eq(conversationMessages.id, input.messageId))
    .limit(1);

  if (!message?.id) return;
  if (message.direction !== "inbound") return;
  if (
    message.channel !== "sms" &&
    message.channel !== "dm" &&
    message.channel !== "email"
  )
    return;

  const inboxAlerts = await getInboxAlertsPolicy(input.db);
  const alertAllowed =
    message.channel === "sms"
      ? inboxAlerts.sms
      : message.channel === "dm"
        ? inboxAlerts.dm
        : message.channel === "email"
          ? inboxAlerts.email
          : false;
  if (!alertAllowed) return;

  const [alreadySent] = await input.db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        or(
          eq(auditLogs.action, "inbox.alert.sent"),
          eq(auditLogs.action, "inbox.alert.sms.sent"),
        ),
        eq(auditLogs.entityType, "conversation_message"),
        eq(auditLogs.entityId, input.messageId),
      ),
    )
    .limit(1);

  if (alreadySent?.id) return;

  const contactId =
    typeof message.contactId === "string" ? message.contactId : null;
  if (!contactId) return;

  const config = await getSalesScorecardConfig(input.db);
  const assignedTo = message.assignedTo ?? config.defaultAssigneeMemberId;
  if (!assignedTo) return;

  const phoneMap = await getTeamMemberPhoneMap(input.db);
  const recipientPhone = normalizePhoneE164(phoneMap[assignedTo] ?? "");
  if (!recipientPhone) return;

  const contactName =
    [message.contactFirstName, message.contactLastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
  const contactPhone =
    (message.contactPhoneE164 ?? message.contactPhone ?? "").trim() || null;
  const text = buildInboundInboxAlertText({
    contactName,
    contactPhone,
    body: message.body ?? "",
    channel: message.channel ?? null,
  });

  const result = await sendSmsMessage(recipientPhone, text);
  if (result.ok) {
    await recordProviderSuccessSafe("sms");
    await recordAuditEvent({
      actor: { type: "worker", label: "outbox" },
      action: "inbox.alert.sent",
      entityType: "conversation_message",
      entityId: input.messageId,
      meta: {
        to: recipientPhone,
        contactId,
        assignedTo,
        inboundChannel: message.channel ?? null,
        provider: result.provider ?? null,
      },
    });
    return;
  }

  await recordProviderFailureSafe("sms", result.detail ?? null);
  await recordAuditEvent({
    actor: { type: "worker", label: "outbox" },
    action: "inbox.alert.failed",
    entityType: "conversation_message",
    entityId: input.messageId,
    meta: {
      to: recipientPhone,
      contactId,
      assignedTo,
      inboundChannel: message.channel ?? null,
      provider: result.provider ?? null,
      detail: result.detail ?? null,
    },
  });
}

function parseLocalTime(
  value: string,
): { hour: number; minute: number } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function resolveLocalDueAt(
  base: Date,
  config: Awaited<ReturnType<typeof getSalesScorecardConfig>>,
  time: string,
  dayOffset = 0,
): Date | null {
  const parsed = parseLocalTime(time);
  if (!parsed) return null;
  const local = DateTime.fromJSDate(base, { zone: config.timezone }).plus({
    days: dayOffset,
  });
  const at = local.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
  if (!at.isValid) return null;
  return at.toUTC().toJSDate();
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

async function completeSalesTasksForContact(
  db: ReturnType<typeof getDb>,
  contactId: string,
  now: Date,
): Promise<void> {
  const id = contactId.trim();
  if (!id) return;

  await db
    .update(crmTasks)
    .set({ status: "completed", updatedAt: now })
    .where(
      and(
        eq(crmTasks.contactId, id),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.notes),
        or(
          ilike(crmTasks.notes, "%kind=speed_to_lead%"),
          ilike(crmTasks.notes, "%kind=follow_up%"),
        ),
      ),
    );
}

async function ensureSalesFollowupsForLead(input: {
  db: ReturnType<typeof getDb>;
  leadId: string;
  outboxEventId: string;
  payload: Record<string, unknown> | null;
}): Promise<void> {
  const existingFlag = input.payload?.["scheduledSalesFollowups"] === true;
  if (existingFlag) return;

  const config = await getSalesScorecardConfig(input.db);
  const [row] = await input.db
    .select({
      leadId: leads.id,
      leadCreatedAt: leads.createdAt,
      contactId: leads.contactId,
      contactCreatedAt: contacts.createdAt,
      stage: crmPipeline.stage,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
    })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, leads.contactId))
    .where(eq(leads.id, input.leadId))
    .limit(1);

  if (!row?.leadId) return;
  if (row.stage === "won" || row.stage === "lost") return;

  const assigneeId = row.salespersonMemberId ?? config.defaultAssigneeMemberId;
  if (!row.salespersonMemberId) {
    await input.db
      .update(contacts)
      .set({ salespersonMemberId: assigneeId, updatedAt: new Date() })
      .where(eq(contacts.id, row.contactId));
  }

  const leadTag = buildLeadTag(row.leadId);
  const contactTag = buildContactTag(row.contactId);
  const [existing] = await input.db
    .select({ id: crmTasks.id })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, row.contactId),
        isNotNull(crmTasks.notes),
        or(
          ilike(crmTasks.notes, `%${leadTag}%`),
          ilike(crmTasks.notes, `%${contactTag}%`),
        ),
      ),
    )
    .limit(1);

  if (existing?.id) {
    await input.db
      .update(outboxEvents)
      .set({
        payload: { ...(input.payload ?? {}), scheduledSalesFollowups: true },
      })
      .where(eq(outboxEvents.id, input.outboxEventId));
    return;
  }

  const now = new Date();
  const leadCreatedAt = row.contactCreatedAt ?? row.leadCreatedAt;
  const { clockStart, isWithinBusinessHours } = resolveSalesClockStart(
    leadCreatedAt,
    config.timezone,
  );
  const speedDeadline = new Date(
    clockStart.getTime() + config.speedToLeadMinutes * 60_000,
  );

  const tasksToCreate: Array<{ title: string; dueAt: Date; notes: string }> =
    [];
  const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
  const speedTitle = hasPhone
    ? "Auto: Call new lead (5 min SLA)"
    : "Auto: Message new lead (5 min SLA)";
  tasksToCreate.push({
    title: speedTitle,
    dueAt: normalizeSalesDueAt(speedDeadline, config.timezone),
    notes: `${contactTag}\n${leadTag}\nkind=speed_to_lead`,
  });

  const followupDues: Array<{ dueAt: Date; step: string }> = [];
  for (const minutes of config.followupStepsMinutes) {
    if (minutes <= config.speedToLeadMinutes) continue;
    followupDues.push({
      dueAt: new Date(clockStart.getTime() + minutes * 60_000),
      step: `relative_${minutes}`,
    });
  }

  const SAME_DAY_MIN_LEAD_AGE_MINUTES = 180;
  const sameDay = resolveLocalDueAt(
    clockStart,
    config,
    config.followupSameDayLocalTime,
    0,
  );
  if (sameDay) {
    const minAllowed = new Date(
      clockStart.getTime() + SAME_DAY_MIN_LEAD_AGE_MINUTES * 60_000,
    );
    if (sameDay.getTime() >= minAllowed.getTime()) {
      followupDues.push({ dueAt: sameDay, step: "fixed_same_day" });
    }
  }

  const nextMorning = resolveLocalDueAt(
    clockStart,
    config,
    config.followupNextDayMorningLocalTime,
    1,
  );
  if (nextMorning)
    followupDues.push({ dueAt: nextMorning, step: "fixed_next_morning" });
  const nextAfternoon = resolveLocalDueAt(
    clockStart,
    config,
    config.followupNextDayAfternoonLocalTime,
    1,
  );
  if (nextAfternoon)
    followupDues.push({ dueAt: nextAfternoon, step: "fixed_next_afternoon" });

  for (const days of config.followupReactivationDays) {
    const reactivation = resolveLocalDueAt(
      clockStart,
      config,
      config.followupNextDayMorningLocalTime,
      days,
    );
    if (reactivation) {
      followupDues.push({
        dueAt: reactivation,
        step: `reactivation_day_${days}`,
      });
    }
  }

  const seenFollowupKeys = new Set<string>();
  for (const entry of followupDues) {
    const normalizedDue = normalizeSalesDueAt(entry.dueAt, config.timezone);
    if (normalizedDue.getTime() <= speedDeadline.getTime()) continue;
    const stepMinutes = Math.max(1, minutesBetween(clockStart, normalizedDue));
    const key = `${normalizedDue.toISOString()}:${entry.step}`;
    if (seenFollowupKeys.has(key)) continue;
    seenFollowupKeys.add(key);
    tasksToCreate.push({
      title: "Auto: Follow up",
      dueAt: normalizedDue,
      notes: `${contactTag}\n${leadTag}\nkind=follow_up\nstep=${entry.step}\nstepMinutes=${stepMinutes}`,
    });
  }

  const scheduledPreCall = await input.db.transaction(async (tx) => {
    let preCall: { taskId: string; callAt: Date } | null = null;
    for (const task of tasksToCreate) {
      const [created] = await tx
        .insert(crmTasks)
        .values({
          contactId: row.contactId,
          title: task.title,
          notes: task.notes,
          dueAt: task.dueAt,
          assignedTo: assigneeId,
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: crmTasks.id });

      if (!created?.id) continue;

      const isFollowupTask = task.notes.includes("kind=follow_up");
      const isSpeedToLeadTask = task.notes.includes("kind=speed_to_lead");

      if (!isFollowupTask && !isSpeedToLeadTask) {
        await tx.insert(outboxEvents).values({
          type: "crm.reminder.sms",
          payload: { taskId: created.id },
          nextAttemptAt: task.dueAt,
        });
      }

      if (SALES_ESCALATION_CALL_ENABLED && hasPhone && isSpeedToLeadTask) {
        const delayMs = 30_000;
        const instantAt = isWithinBusinessHours
          ? new Date(now.getTime() + delayMs)
          : clockStart;
        await tx.insert(outboxEvents).values({
          type: "sales.escalation.call",
          payload: { taskId: created.id, mode: "instant" },
          nextAttemptAt: instantAt,
        });
        console.info("[outbox] sales.escalation.scheduled", {
          taskId: created.id,
          mode: "instant",
          nextAttemptAt: instantAt.toISOString(),
        });
        if (!preCall) {
          preCall = { taskId: created.id, callAt: instantAt };
        }
      }
    }

    await tx
      .update(outboxEvents)
      .set({
        payload: { ...(input.payload ?? {}), scheduledSalesFollowups: true },
      })
      .where(eq(outboxEvents.id, input.outboxEventId));
    return preCall;
  });

  if (scheduledPreCall) {
    try {
      await scheduleSpeedToLeadPreCallSms({
        db: input.db,
        leadId: row.leadId,
        contactId: row.contactId,
        taskId: scheduledPreCall.taskId,
        callAt: scheduledPreCall.callAt,
      });
    } catch (error) {
      console.warn("[outbox] sales.escalation.pre_call_sms_failed", {
        leadId: row.leadId,
        contactId: row.contactId,
        taskId: scheduledPreCall.taskId,
        error: String(error),
      });
    }
  }
}

async function ensureSalesFollowupsForContact(input: {
  db: ReturnType<typeof getDb>;
  contactId: string;
  outboxEventId: string;
  payload: Record<string, unknown> | null;
}): Promise<void> {
  const existingFlag = input.payload?.["scheduledSalesFollowups"] === true;
  if (existingFlag) return;

  const source =
    typeof input.payload?.["source"] === "string"
      ? input.payload["source"].trim()
      : "";
  const allowInstantCallEscalation =
    source.length > 0 ? source === "lead" : false;

  const config = await getSalesScorecardConfig(input.db);
  const [contactRow] = await input.db
    .select({
      contactId: contacts.id,
      createdAt: contacts.createdAt,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
      stage: crmPipeline.stage,
    })
    .from(contacts)
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  if (!contactRow?.contactId) return;
  if (contactRow.stage === "won" || contactRow.stage === "lost") return;

  const assigneeId =
    contactRow.salespersonMemberId ?? config.defaultAssigneeMemberId;
  if (!contactRow.salespersonMemberId) {
    await input.db
      .update(contacts)
      .set({ salespersonMemberId: assigneeId, updatedAt: new Date() })
      .where(eq(contacts.id, contactRow.contactId));
  }

  const contactTag = buildContactTag(contactRow.contactId);
  const [existingLead] = await input.db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.contactId, contactRow.contactId))
    .orderBy(desc(leads.createdAt), desc(leads.updatedAt))
    .limit(1);
  const leadTag = existingLead?.id ? buildLeadTag(existingLead.id) : null;

  const [existing] = await input.db
    .select({ id: crmTasks.id })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, contactRow.contactId),
        isNotNull(crmTasks.notes),
        leadTag
          ? or(
              ilike(crmTasks.notes, `%${contactTag}%`),
              ilike(crmTasks.notes, `%${leadTag}%`),
            )
          : ilike(crmTasks.notes, `%${contactTag}%`),
      ),
    )
    .limit(1);

  if (existing?.id) {
    await input.db
      .update(outboxEvents)
      .set({
        payload: { ...(input.payload ?? {}), scheduledSalesFollowups: true },
      })
      .where(eq(outboxEvents.id, input.outboxEventId));
    return;
  }

  const now = new Date();
  const { clockStart, isWithinBusinessHours } = resolveSalesClockStart(
    contactRow.createdAt,
    config.timezone,
  );
  const speedDeadline = new Date(
    clockStart.getTime() + config.speedToLeadMinutes * 60_000,
  );

  const tasksToCreate: Array<{ title: string; dueAt: Date; notes: string }> =
    [];
  const hasPhone = Boolean(
    (contactRow.phoneE164 ?? contactRow.phone ?? "").trim().length,
  );
  const speedTitle = hasPhone
    ? "Auto: Call new lead (5 min SLA)"
    : "Auto: Message new lead (5 min SLA)";

  const tagBlock = leadTag ? `${contactTag}\n${leadTag}` : contactTag;
  tasksToCreate.push({
    title: speedTitle,
    dueAt: normalizeSalesDueAt(speedDeadline, config.timezone),
    notes: `${tagBlock}\nkind=speed_to_lead`,
  });

  const followupDues: Array<{ dueAt: Date; step: string }> = [];
  for (const minutes of config.followupStepsMinutes) {
    if (minutes <= config.speedToLeadMinutes) continue;
    followupDues.push({
      dueAt: new Date(clockStart.getTime() + minutes * 60_000),
      step: `relative_${minutes}`,
    });
  }

  const SAME_DAY_MIN_LEAD_AGE_MINUTES = 180;
  const sameDay = resolveLocalDueAt(
    clockStart,
    config,
    config.followupSameDayLocalTime,
    0,
  );
  if (sameDay) {
    const minAllowed = new Date(
      clockStart.getTime() + SAME_DAY_MIN_LEAD_AGE_MINUTES * 60_000,
    );
    if (sameDay.getTime() >= minAllowed.getTime()) {
      followupDues.push({ dueAt: sameDay, step: "fixed_same_day" });
    }
  }

  const nextMorning = resolveLocalDueAt(
    clockStart,
    config,
    config.followupNextDayMorningLocalTime,
    1,
  );
  if (nextMorning)
    followupDues.push({ dueAt: nextMorning, step: "fixed_next_morning" });
  const nextAfternoon = resolveLocalDueAt(
    clockStart,
    config,
    config.followupNextDayAfternoonLocalTime,
    1,
  );
  if (nextAfternoon)
    followupDues.push({ dueAt: nextAfternoon, step: "fixed_next_afternoon" });

  for (const days of config.followupReactivationDays) {
    const reactivation = resolveLocalDueAt(
      clockStart,
      config,
      config.followupNextDayMorningLocalTime,
      days,
    );
    if (reactivation) {
      followupDues.push({
        dueAt: reactivation,
        step: `reactivation_day_${days}`,
      });
    }
  }

  const seenFollowupKeys = new Set<string>();
  for (const entry of followupDues) {
    const normalizedDue = normalizeSalesDueAt(entry.dueAt, config.timezone);
    if (normalizedDue.getTime() <= speedDeadline.getTime()) continue;
    const stepMinutes = Math.max(1, minutesBetween(clockStart, normalizedDue));
    const key = `${normalizedDue.toISOString()}:${entry.step}`;
    if (seenFollowupKeys.has(key)) continue;
    seenFollowupKeys.add(key);
    tasksToCreate.push({
      title: "Auto: Follow up",
      dueAt: normalizedDue,
      notes: `${tagBlock}\nkind=follow_up\nstep=${entry.step}\nstepMinutes=${stepMinutes}`,
    });
  }

  const scheduledPreCall = await input.db.transaction(async (tx) => {
    let preCall: { taskId: string; callAt: Date } | null = null;
    for (const task of tasksToCreate) {
      const [created] = await tx
        .insert(crmTasks)
        .values({
          contactId: contactRow.contactId,
          title: task.title,
          notes: task.notes,
          dueAt: task.dueAt,
          assignedTo: assigneeId,
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: crmTasks.id });

      if (!created?.id) continue;

      const isFollowupTask = task.notes.includes("kind=follow_up");
      const isSpeedToLeadTask = task.notes.includes("kind=speed_to_lead");

      if (!isFollowupTask && !isSpeedToLeadTask) {
        await tx.insert(outboxEvents).values({
          type: "crm.reminder.sms",
          payload: { taskId: created.id },
          nextAttemptAt: task.dueAt,
        });
      }

      if (SALES_ESCALATION_CALL_ENABLED && hasPhone && isSpeedToLeadTask) {
        if (!allowInstantCallEscalation) continue;
        const delayMs = 30_000;
        const instantAt = isWithinBusinessHours
          ? new Date(now.getTime() + delayMs)
          : clockStart;
        await tx.insert(outboxEvents).values({
          type: "sales.escalation.call",
          payload: { taskId: created.id, mode: "instant" },
          nextAttemptAt: instantAt,
        });
        if (!preCall) {
          preCall = { taskId: created.id, callAt: instantAt };
        }
      }
    }

    await tx
      .update(outboxEvents)
      .set({
        payload: { ...(input.payload ?? {}), scheduledSalesFollowups: true },
      })
      .where(eq(outboxEvents.id, input.outboxEventId));
    return preCall;
  });

  if (scheduledPreCall && allowInstantCallEscalation) {
    try {
      await scheduleSpeedToLeadPreCallSms({
        db: input.db,
        leadId: null,
        contactId: contactRow.contactId,
        taskId: scheduledPreCall.taskId,
        callAt: scheduledPreCall.callAt,
      });
    } catch (error) {
      console.warn("[outbox] sales.escalation.pre_call_sms_failed", {
        contactId: contactRow.contactId,
        taskId: scheduledPreCall.taskId,
        error: String(error),
      });
    }
  }
}

async function scheduleSpeedToLeadPreCallSms(input: {
  db: ReturnType<typeof getDb>;
  leadId: string | null;
  contactId: string;
  taskId: string;
  callAt: Date;
}): Promise<void> {
  const PRE_CALL_LEAD_MS = 20_000;
  const now = new Date();
  const preCallAt = new Date(
    Math.max(now.getTime(), input.callAt.getTime() - PRE_CALL_LEAD_MS),
  );

  const [existing] = await input.db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .where(
      and(
        eq(conversationThreads.contactId, input.contactId),
        eq(conversationMessages.direction, "outbound"),
        eq(conversationMessages.channel, "sms"),
        sql`${conversationMessages.metadata} ->> 'speedToLeadPreCallTaskId' = ${input.taskId}`,
      ),
    )
    .limit(1);
  if (existing?.id) return;

  const [contact] = await input.db
    .select({
      firstName: contacts.firstName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  const toAddress = (contact?.phoneE164 ?? contact?.phone ?? "").trim();
  if (!toAddress) return;

  let threadId: string | null = null;
  if (input.leadId) {
    const [leadRow] = await input.db
      .select({ propertyId: leads.propertyId })
      .from(leads)
      .where(eq(leads.id, input.leadId))
      .limit(1);
    threadId = await ensureThreadForLead(input.db, {
      leadId: input.leadId,
      contactId: input.contactId,
      propertyId: (leadRow?.propertyId as string | null) ?? null,
      channel: "sms",
    });
  } else {
    threadId = await ensureThreadForContactChannel(input.db, {
      contactId: input.contactId,
      channel: "sms",
    });
  }
  if (!threadId) return;

  const who = (contact?.firstName ?? "").trim() || "there";
  const body =
    `Hi ${who}, this is Stonegate Junk Removal — we’re about to call to confirm a couple details and lock in your exact price. ` +
    "If now isn’t a good time, reply with a better time.";

  await queueOutboundMessage({
    db: input.db,
    threadId,
    channel: "sms",
    body,
    toAddress,
    metadata: {
      automation: true,
      autoReply: true,
      speedToLead: true,
      speedToLeadPreCallTaskId: input.taskId,
    },
    nextAttemptAt: preCallAt,
  });

  await recordAuditEvent({
    actor: { type: "worker", label: "outbox" },
    action: "sales.escalation.pre_call_sms.queued",
    entityType: "crm_task",
    entityId: input.taskId,
    meta: {
      contactId: input.contactId,
      leadId: input.leadId,
      threadId,
      nextAttemptAt: preCallAt.toISOString(),
    },
  });
}

function formatReminderDueAt(dueAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
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

async function buildLeadAlertMessage(leadId: string): Promise<{
  text: string;
  phone: string | null;
  mediaUrls: string[] | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      source: leads.source,
      instantQuoteId: leads.instantQuoteId,
      quoteEstimate: leads.quoteEstimate,
      quoteId: leads.quoteId,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      instantQuoteAiResult: instantQuotes.aiResult,
      instantQuotePhotoUrls: instantQuotes.photoUrls,
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(properties, eq(leads.propertyId, properties.id))
    .leftJoin(instantQuotes, eq(leads.instantQuoteId, instantQuotes.id))
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!row) return null;

  const formatCurrency = (value: number): string => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return String(value);
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `$${Math.round(amount)}`;
    }
  };

  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  const phone = row.phoneE164 ?? row.phone ?? null;
  const addressParts = [row.addressLine1, row.city, row.state, row.postalCode]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  const address = addressParts.length ? addressParts.join(", ") : null;
  const source =
    typeof row.source === "string" && row.source.length ? row.source : null;

  const quoteFromInstant = (() => {
    const ai = isRecord(row.instantQuoteAiResult)
      ? row.instantQuoteAiResult
      : null;
    const low = typeof ai?.["priceLow"] === "number" ? ai["priceLow"] : null;
    const high = typeof ai?.["priceHigh"] === "number" ? ai["priceHigh"] : null;
    const discountedLow =
      typeof ai?.["priceLowDiscounted"] === "number"
        ? ai["priceLowDiscounted"]
        : null;
    const discountedHigh =
      typeof ai?.["priceHighDiscounted"] === "number"
        ? ai["priceHighDiscounted"]
        : null;
    const discountPercent =
      typeof ai?.["discountPercent"] === "number" ? ai["discountPercent"] : 0;
    const discountAmount =
      typeof ai?.["discountAmount"] === "number" ? ai["discountAmount"] : 0;
    const tier =
      typeof ai?.["displayTierLabel"] === "string"
        ? ai["displayTierLabel"].trim()
        : "";
    const needsEstimate = ai?.["needsInPersonEstimate"] === true;
    if (typeof low !== "number" || !Number.isFinite(low)) return null;
    if (typeof high !== "number" || !Number.isFinite(high)) return null;

    const formatRange = (a: number, b: number): string =>
      a === b ? formatCurrency(a) : `${formatCurrency(a)}-${formatCurrency(b)}`;

    const tierLabel = tier.length ? ` (${tier})` : "";
    const estimateFlag = needsEstimate ? " (needs estimate)" : "";

    // Keep lead alert consistent with the saved customer-facing quote range.
    if (
      typeof discountedLow === "number" &&
      Number.isFinite(discountedLow) &&
      typeof discountedHigh === "number" &&
      Number.isFinite(discountedHigh)
    ) {
      const normalizedDiscountedHigh = Math.max(discountedLow, discountedHigh);
      const discountLabel =
        discountPercent > 0 && discountPercent < 1
          ? `${Math.round(discountPercent * 100)}% off`
          : discountAmount > 0
            ? `${formatCurrency(discountAmount)} off`
            : "discount applied";
      const baseLabel = formatRange(low, high);
      const discountedLabel = formatRange(
        discountedLow,
        normalizedDiscountedHigh,
      );
      if (discountedLabel !== baseLabel) {
        return `Quote: ${discountedLabel}${tierLabel} (${discountLabel}; was ${baseLabel})${estimateFlag}`;
      }
    }

    return `Quote: ${formatRange(low, high)}${tierLabel}${estimateFlag}`;
  })();

  const quoteFromEstimate =
    typeof row.quoteEstimate === "string" && row.quoteEstimate.trim().length
      ? `Quote: ${formatCurrency(Number(row.quoteEstimate))}`
      : null;

  const quote = quoteFromInstant ?? quoteFromEstimate ?? null;

  const pieces = [
    name ? `New lead: ${name}` : "New lead received",
    phone ? `Phone: ${phone}` : null,
    quote,
    address ? `Address: ${address}` : null,
    source ? `Source: ${source}` : null,
  ].filter(Boolean);

  const mediaUrls = Array.isArray(row.instantQuotePhotoUrls)
    ? row.instantQuotePhotoUrls
        .filter(
          (url): url is string =>
            typeof url === "string" && url.trim().length > 0,
        )
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch {
            return false;
          }
        })
        .slice(0, 4)
    : [];

  return {
    text: pieces.join(" | "),
    phone,
    mediaUrls: mediaUrls.length ? mediaUrls : null,
  };
}

function buildCalendarPayloadFromNotification(
  notification: EstimateNotificationPayload,
): AppointmentCalendarPayload | null {
  const appointment = notification.appointment;
  if (!appointment.startAt) {
    return null;
  }

  const rescheduleUrl =
    appointment.rescheduleUrl ??
    buildRescheduleUrlForAppointment(
      appointment.id,
      appointment.rescheduleToken,
    ) ??
    undefined;

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
      phone: notification.contact.phone ?? null,
    },
    property: {
      addressLine1: notification.property.addressLine1,
      city: notification.property.city,
      state: notification.property.state,
      postalCode: notification.property.postalCode,
    },
    rescheduleUrl,
  };
}

async function ensureCalendarEventCreated(
  notification: EstimateNotificationPayload,
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
    console.warn("[calendar] create_skipped", {
      appointmentId: notification.appointment.id,
    });
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
      error: String(error),
    });
  }

  return eventId;
}

async function syncCalendarEventForReschedule(
  notification: EstimateNotificationPayload,
): Promise<string | null> {
  const payload = buildCalendarPayloadFromNotification(notification);
  if (!payload) {
    return notification.appointment.calendarEventId ?? null;
  }

  const db = getDb();
  let calendarEventId = notification.appointment.calendarEventId ?? null;

  if (calendarEventId) {
    const updated = await updateCalendarEventWithRetry(
      calendarEventId,
      payload,
    );
    if (updated) {
      return calendarEventId;
    }
    console.warn("[calendar] update_retry_failed", {
      appointmentId: notification.appointment.id,
      eventId: calendarEventId,
    });
  }

  calendarEventId = await createCalendarEventWithRetry(payload);
  if (!calendarEventId) {
    console.warn("[calendar] create_after_update_failed", {
      appointmentId: notification.appointment.id,
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
      error: String(error),
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
    contact?: Partial<EstimateNotificationPayload["contact"]>;
  },
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
      leadFormPayload: leads.formPayload,
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
        ? row.leadServices.filter(
            (service): service is string =>
              typeof service === "string" && service.length > 0,
          )
        : [];

  const formPayload = isRecord(row.leadFormPayload)
    ? row.leadFormPayload
    : null;
  const schedulingPayload =
    formPayload && isRecord(formPayload["scheduling"])
      ? formPayload["scheduling"]
      : null;

  const scheduling: EstimateNotificationPayload["scheduling"] = {
    preferredDate:
      overrides?.scheduling?.preferredDate ??
      (typeof schedulingPayload?.["preferredDate"] === "string"
        ? schedulingPayload["preferredDate"]
        : null),
    alternateDate:
      overrides?.scheduling?.alternateDate ??
      (typeof schedulingPayload?.["alternateDate"] === "string"
        ? schedulingPayload["alternateDate"]
        : null),
    timeWindow:
      overrides?.scheduling?.timeWindow ??
      (typeof schedulingPayload?.["timeWindow"] === "string"
        ? schedulingPayload["timeWindow"]
        : null),
  };

  const contactNameParts = [row.contactFirstName, row.contactLastName].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const overrideContactName =
    typeof overrides?.contact?.name === "string" &&
    overrides.contact.name.trim().length > 0
      ? overrides.contact.name.trim()
      : null;
  const contactName =
    overrideContactName ||
    contactNameParts.join(" ").trim() ||
    row.contactFirstName ||
    row.contactLastName ||
    "Stonegate Customer";
  const overrideContactPhone =
    typeof overrides?.contact?.phone === "string" &&
    overrides.contact.phone.trim().length > 0
      ? overrides.contact.phone.trim()
      : null;
  const overrideContactEmail =
    typeof overrides?.contact?.email === "string" &&
    overrides.contact.email.trim().length > 0
      ? overrides.contact.email.trim()
      : null;

  const status: AppointmentStatus = isValidAppointmentStatus(row.status)
    ? row.status
    : "requested";

  let rescheduleToken =
    typeof row.rescheduleToken === "string" ? row.rescheduleToken.trim() : "";
  if (!rescheduleToken) {
    rescheduleToken = nanoid(24);
    try {
      await db
        .update(appointments)
        .set({ rescheduleToken, updatedAt: new Date() })
        .where(eq(appointments.id, appointmentId));
    } catch (error) {
      console.warn("[outbox] reschedule_token_backfill_failed", {
        appointmentId,
        error: String(error),
      });
    }
  }

  const rescheduleUrl =
    overrides?.rescheduleUrl ??
    buildRescheduleUrlForAppointment(row.appointmentId, rescheduleToken) ??
    undefined;

  const payload: EstimateNotificationPayload = {
    leadId: row.leadId ?? "unknown",
    contactId: row.contactId ?? undefined,
    services,
    contact: {
      name: contactName,
      email: overrideContactEmail ?? row.contactEmail ?? undefined,
      phone:
        overrideContactPhone ??
        row.contactPhoneE164 ??
        row.contactPhone ??
        undefined,
    },
    property: {
      addressLine1: row.propertyAddressLine1 ?? "Undisclosed address",
      city: row.propertyCity ?? "",
      state: row.propertyState ?? "",
      postalCode: row.propertyPostalCode ?? "",
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
      calendarEventId: row.calendarEventId ?? null,
    },
    notes:
      overrides?.notes ??
      (typeof row.leadNotes === "string" ? row.leadNotes : null),
  };

  return payload;
}

async function buildQuoteNotificationPayload(
  quoteId: string,
  overrides?: {
    notes?: string | null;
  },
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
      propertyPostalCode: properties.postalCode,
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
    ? row.services.filter(
        (service): service is string =>
          typeof service === "string" && service.trim().length > 0,
      )
    : [];

  const shareToken = row.shareToken ?? null;
  const shareUrl = shareToken ? buildQuoteShareUrl(shareToken) : null;
  if (!shareUrl) {
    console.warn("[outbox] quote_missing_share_url", {
      quoteId,
      reason: "public_site_url_missing_or_unsafe",
    });
    return null;
  }

  const contactNameParts = [row.contactFirstName, row.contactLastName].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const customerName =
    contactNameParts.join(" ").trim() ||
    row.contactFirstName ||
    "Stonegate Customer";

  const total = Number(row.total ?? 0);
  const depositDue = Number(row.depositDue ?? 0);
  const balanceDue = Number(row.balanceDue ?? 0);
  const deliveryChannels = resolveUsableQuoteDeliveryChannels({
    email: row.contactEmail,
    phone: row.contactPhone,
    phoneE164: row.contactPhoneE164,
  });

  return {
    quoteId,
    services,
    contact: {
      name: customerName,
      email: deliveryChannels.email,
      phone: deliveryChannels.phone,
    },
    contactId: row.contactId ?? null,
    total,
    depositDue,
    balanceDue,
    shareUrl,
    expiresAt: row.expiresAt ?? null,
    notes: overrides?.notes ?? null,
  };
}

async function loadQuoteWorkflowContactId(
  quoteId: string,
): Promise<string | null> {
  const [quote] = await getDb()
    .select({ contactId: quotes.contactId })
    .from(quotes)
    .where(eq(quotes.id, quoteId))
    .limit(1);
  if (!quote) {
    console.warn("[outbox] quote_workflow_not_found", { quoteId });
    return null;
  }
  return quote.contactId;
}

async function updatePipelineStageForContact(
  contactId: string | null | undefined,
  targetStage: PipelineStage,
  reason: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!contactId || !PIPELINE_STAGE_SET.has(targetStage)) {
    return;
  }

  const db = getDb();
  const [existing] = await db
    .select({ stage: crmPipeline.stage })
    .from(crmPipeline)
    .where(eq(crmPipeline.contactId, contactId))
    .limit(1);

  const previousStage = (existing?.stage ?? null) as PipelineStage | null;
  if (!canAutomaticallyTransitionPipeline(previousStage, targetStage)) {
    return;
  }

  const [updated] = await db
    .insert(crmPipeline)
    .values({ contactId, stage: targetStage })
    .onConflictDoUpdate({
      target: crmPipeline.contactId,
      set: {
        stage: targetStage,
        updatedAt: new Date(),
      },
      setWhere: sql`${crmPipeline.stage} NOT IN ('won', 'lost')`,
    })
    .returning({ stage: crmPipeline.stage });
  if (!updated) return;

  await db.insert(outboxEvents).values({
    type: "pipeline.auto_stage_change",
    payload: {
      contactId,
      fromStage: previousStage,
      toStage: targetStage,
      reason,
      meta,
    },
  });
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

async function clearLeadFollowups(
  leadId: string | null | undefined,
  options?: { excludeOutboxEventId?: string },
): Promise<void> {
  if (!leadId) return;
  const db = getDb();
  const now = new Date();

  await db
    .update(leadAutomationStates)
    .set({
      followupState: "stopped",
      followupStep: 0,
      nextFollowupAt: null,
      updatedAt: now,
    })
    .where(eq(leadAutomationStates.leadId, leadId));

  const outboxFilters: SQL<unknown>[] = [
    eq(outboxEvents.type, "followup.send"),
    isNull(outboxEvents.processedAt),
    isNull(outboxEvents.quarantinedAt),
    sql`(payload->>'leadId') = ${leadId}`,
  ];
  if (options?.excludeOutboxEventId) {
    outboxFilters.push(ne(outboxEvents.id, options.excludeOutboxEventId));
  }

  await db.delete(outboxEvents).where(and(...outboxFilters));
}

async function getAutomationMode(
  db: ReturnType<typeof getDb>,
  channel: FollowUpChannel,
): Promise<"draft" | "assist" | "auto"> {
  const [row] = await db
    .select({ mode: automationSettings.mode })
    .from(automationSettings)
    .where(eq(automationSettings.channel, channel))
    .limit(1);

  return row?.mode ?? "draft";
}

async function getLeadAutomationState(
  db: ReturnType<typeof getDb>,
  leadId: string,
  channel: FollowUpChannel,
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
      followupState: leadAutomationStates.followupState,
    })
    .from(leadAutomationStates)
    .where(
      and(
        eq(leadAutomationStates.leadId, leadId),
        eq(leadAutomationStates.channel, channel),
      ),
    )
    .limit(1);

  return (
    row ?? {
      paused: false,
      dnc: false,
      humanTakeover: false,
      followupState: null,
    }
  );
}

function getContactChannelAddress(
  contact: {
    email?: string | null;
    phone?: string | null;
    phoneE164?: string | null;
  },
  channel: FollowUpChannel,
): string | null {
  return channel === "sms"
    ? (contact.phoneE164 ?? contact.phone ?? null)
    : (contact.email ?? null);
}

async function resolveFollowUpChannel(
  db: ReturnType<typeof getDb>,
  leadId: string,
  contact: {
    email?: string | null;
    phone?: string | null;
    phoneE164?: string | null;
  },
  preferred: FollowUpChannel[] = ["sms", "email"],
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
  input: {
    leadId: string;
    contactId: string;
    propertyId: string | null;
    channel: FollowUpChannel;
  },
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.leadId, input.leadId),
        eq(conversationThreads.channel, input.channel),
      ),
    )
    .orderBy(
      desc(conversationThreads.lastMessageAt),
      desc(conversationThreads.updatedAt),
    )
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
      updatedAt: now,
    })
    .returning({ id: conversationThreads.id });

  return created?.id ?? null;
}

async function ensureThreadForContactChannel(
  db: ReturnType<typeof getDb>,
  input: { contactId: string; channel: FollowUpChannel },
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, input.contactId),
        eq(conversationThreads.channel, input.channel),
      ),
    )
    .orderBy(
      desc(conversationThreads.lastMessageAt),
      desc(conversationThreads.updatedAt),
    )
    .limit(1);

  if (existing?.id) {
    return existing.id;
  }

  const [latestLead] = await db
    .select({ leadId: leads.id, propertyId: leads.propertyId })
    .from(leads)
    .where(eq(leads.contactId, input.contactId))
    .orderBy(desc(leads.createdAt), desc(leads.updatedAt))
    .limit(1);

  const now = new Date();
  const [created] = await db
    .insert(conversationThreads)
    .values({
      contactId: input.contactId,
      leadId: latestLead?.leadId ?? null,
      propertyId: latestLead?.propertyId ?? null,
      status: "open",
      channel: input.channel,
      subject: input.channel === "email" ? "Stonegate follow-up" : null,
      lastMessagePreview: "Follow-up scheduled",
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
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
  nextAttemptAt?: Date | null;
}): Promise<string | null> {
  const now = new Date();
  const [existingParticipant] = await input.db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, input.threadId),
        eq(conversationParticipants.participantType, "system"),
      ),
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
          createdAt: now,
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
      createdAt: now,
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
      updatedAt: now,
    })
    .where(eq(conversationThreads.id, input.threadId));

  await input.db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: now,
    nextAttemptAt: input.nextAttemptAt ?? null,
  });

  return message.id;
}

async function hasAnyOutboundForContact(
  db: ReturnType<typeof getDb>,
  contactId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationMessages.direction, "outbound"),
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

async function hasAutoFirstTouchForContact(
  db: ReturnType<typeof getDb>,
  contactId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationMessages.threadId, conversationThreads.id),
    )
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationMessages.direction, "outbound"),
        sql`${conversationMessages.metadata} ->> 'autoFirstTouch' = 'true'`,
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

async function queueAutoFirstTouchSms(input: {
  db: ReturnType<typeof getDb>;
  contactId: string;
  leadId?: string | null;
  leadPropertyId?: string | null;
  propertyCity?: string | null;
  propertyPostalCode?: string | null;
}): Promise<void> {
  if (!AUTO_FIRST_TOUCH_SMS_ENABLED) return;

  const [contact] = await input.db
    .select({
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  if (!contact) return;
  const toAddress = (contact.phoneE164 ?? contact.phone ?? "").trim();
  if (!toAddress) return;

  if (await hasAutoFirstTouchForContact(input.db, input.contactId)) return;
  if (await hasAnyOutboundForContact(input.db, input.contactId)) return;

  const templatesPolicy = await getTemplatesPolicy(input.db);
  const serviceArea = await getServiceAreaPolicy(input.db);
  const knownCity =
    typeof input.propertyCity === "string" &&
    input.propertyCity.trim().length > 0
      ? input.propertyCity.trim()
      : null;
  const outOfServiceArea = knownCity
    ? !isCityAllowed(knownCity, serviceArea)
    : null;
  const isOutOfArea = outOfServiceArea === true;
  const autoSendEligible =
    (await getAutomationMode(input.db, "sms")) === "auto";
  const templateGroup = isOutOfArea
    ? templatesPolicy.out_of_area
    : templatesPolicy.first_touch;
  const body =
    resolveTemplateForChannel(templateGroup, { replyChannel: "sms" }) ??
    "Thanks for reaching out to Stonegate Junk Removal. We can help. What items are you needing removed and what timeframe?";

  const threadId = input.leadId
    ? await ensureThreadForLead(input.db, {
        leadId: input.leadId,
        contactId: input.contactId,
        propertyId: input.leadPropertyId ?? null,
        channel: "sms",
      })
    : await ensureThreadForContactChannel(input.db, {
        contactId: input.contactId,
        channel: "sms",
      });

  if (!threadId) return;

  const now = new Date();
  const autopilotPolicy = await getSalesAutopilotPolicy(input.db);

  await input.db.transaction(async (tx) => {
    const [existingParticipant] = await tx
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.threadId, threadId),
          eq(conversationParticipants.participantType, "team"),
          eq(
            conversationParticipants.displayName,
            autopilotPolicy.agentDisplayName,
          ),
          sql`${conversationParticipants.teamMemberId} is null`,
        ),
      )
      .limit(1);

    const participantId =
      existingParticipant?.id ??
      (
        await tx
          .insert(conversationParticipants)
          .values({
            threadId,
            participantType: "team",
            teamMemberId: null,
            displayName: autopilotPolicy.agentDisplayName,
            createdAt: now,
          })
          .returning({ id: conversationParticipants.id })
      )[0]?.id ??
      null;

    if (!participantId) return;

    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction: "outbound",
        channel: "sms",
        subject: null,
        body,
        toAddress,
        deliveryStatus: "queued",
        metadata: {
          draft: true,
          automation: true,
          salesAutopilot: true,
          autoFirstTouch: true,
          salesAutopilotNoAutosend: autoSendEligible ? undefined : true,
          outOfArea: isOutOfArea || undefined,
          serviceAreaOutOfArea: outOfServiceArea === true ? true : undefined,
          leadId: input.leadId ?? undefined,
        },
        createdAt: now,
      })
      .returning({ id: conversationMessages.id });

    if (!message?.id) return;

    if (autoSendEligible) {
      await tx.insert(outboxEvents).values({
        type: "sales.autopilot.autosend",
        payload: { draftMessageId: message.id, inboundMessageId: null },
        nextAttemptAt: DateTime.fromJSDate(now)
          .plus({ minutes: autopilotPolicy.autoSendAfterMinutes })
          .toJSDate(),
        createdAt: now,
      });
    }
  });
}

async function scheduleLeadFollowups(
  leadId: string,
  contactId: string,
): Promise<void> {
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
      propertyId: leads.propertyId,
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
    .where(
      and(eq(appointments.leadId, leadId), ne(appointments.status, "canceled")),
    )
    .limit(1);
  if (appointment?.id) {
    return;
  }

  const [contact] = await db
    .select({
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
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
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [leadAutomationStates.leadId, leadAutomationStates.channel],
      set: {
        followupState: "running",
        followupStep: 0,
        nextFollowupAt: firstDue,
        updatedAt: now,
      },
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
        anchorAt: now.toISOString(),
      },
      nextAttemptAt: dueAt,
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
        isNull(outboxEvents.quarantinedAt),
        sql`(payload->>'appointmentId') = ${appointmentId}`,
      ),
    );
}

async function scheduleAppointmentReminders(
  appointmentId: string,
  startAt: Date | null | undefined,
  options?: { reset?: boolean },
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
          sql`(payload->>'windowMinutes') = ${String(windowMinutes)}`,
        ),
      )
      .limit(1);

    if (existing?.id) {
      continue;
    }

    await db.insert(outboxEvents).values({
      type: "estimate.reminder",
      payload: {
        appointmentId,
        windowMinutes,
      },
      nextAttemptAt: reminderAt,
    });
  }
}

async function recordCalendarSyncOutcomeOnce(input: {
  outboxEventId: string;
  appointmentId: string;
  action:
    | "appointment.calendar_sync.succeeded"
    | "appointment.calendar_sync.reconciliation_required";
  outcome: "succeeded" | "failed";
  correlationId: string | null;
  version: string;
  status?: string;
  syncReason?: string;
  providerEventId?: string;
  reason?: string;
}): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, input.action),
        eq(auditLogs.entityType, "appointment"),
        eq(auditLogs.entityId, input.appointmentId),
        sql`${auditLogs.meta} ->> 'outboxEventId' = ${input.outboxEventId}`,
      ),
    )
    .limit(1);
  if (existing?.id) return;

  await recordAuditEvent({
    actor: { type: "worker", label: "outbox" },
    action: input.action,
    entityType: "appointment",
    entityId: input.appointmentId,
    outcome: input.outcome,
    correlationId: input.correlationId,
    surface: "/team/calendar",
    meta: {
      outboxEventId: input.outboxEventId,
      status: input.status ?? "canceled",
      version: input.version,
      calendarSync:
        input.outcome === "succeeded" ? "succeeded" : "reconciliation_required",
      ...(input.syncReason ? { syncReason: input.syncReason } : {}),
      ...(input.providerEventId
        ? { providerEventId: input.providerEventId }
        : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

async function handleAppointmentCalendarSyncRequested(
  event: OutboxEventRecord,
): Promise<OutboxOutcome> {
  if (getTeamOperationKillSwitchForRisk("external") === "external_sends") {
    return {
      status: "retry",
      error: "calendar_sync_external_changes_disabled",
      nextAttemptAt: new Date(Date.now() + 15 * 60_000),
    };
  }
  const payload = isRecord(event.payload) ? event.payload : null;
  const appointmentId = readStringValue(payload?.["appointmentId"]);
  const requestedVersion = readStringValue(payload?.["version"]);
  const correlationId = readStringValue(payload?.["correlationId"]);
  const syncReason = readStringValue(payload?.["reason"]);
  const rawRequestedCalendarEventId = payload?.["requestedCalendarEventId"];
  const requestedCalendarEventId =
    rawRequestedCalendarEventId === null
      ? null
      : readStringValue(rawRequestedCalendarEventId);
  if (
    !appointmentId ||
    !requestedVersion ||
    !syncReason ||
    (rawRequestedCalendarEventId !== null && !requestedCalendarEventId)
  ) {
    return { status: "skipped", error: "calendar_sync_payload_invalid" };
  }

  const db = getDb();
  const [appointment] = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId,
      updatedAt: appointments.updatedAt,
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
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!appointment) {
    return { status: "skipped", error: "calendar_sync_appointment_missing" };
  }

  const currentVersion = appointment.updatedAt.toISOString();
  const deterministicEventId = buildGoogleCalendarEventId(appointmentId);
  const calendarStateBelongsToRequest =
    appointment.calendarEventId === requestedCalendarEventId ||
    (deterministicEventId !== null &&
      appointment.calendarEventId === deterministicEventId);
  if (currentVersion !== requestedVersion || !calendarStateBelongsToRequest) {
    await recordCalendarSyncOutcomeOnce({
      outboxEventId: event.id,
      appointmentId,
      action: "appointment.calendar_sync.reconciliation_required",
      outcome: "failed",
      correlationId,
      version: currentVersion,
      status: appointment.status,
      syncReason,
      reason:
        currentVersion !== requestedVersion
          ? "appointment_version_changed"
          : "calendar_event_changed",
    });
    return {
      status: "skipped",
      error: "calendar_sync_state_changed_reconciliation_required",
    };
  }

  if (syncReason === "appointment.canceled") {
    if (
      appointment.status !== "canceled" ||
      !requestedCalendarEventId ||
      appointment.calendarEventId !== requestedCalendarEventId
    ) {
      await recordCalendarSyncOutcomeOnce({
        outboxEventId: event.id,
        appointmentId,
        action: "appointment.calendar_sync.reconciliation_required",
        outcome: "failed",
        correlationId,
        version: currentVersion,
        status: appointment.status,
        syncReason,
        reason: "cancellation_state_invalid",
      });
      return {
        status: "skipped",
        error: "calendar_cancel_state_reconciliation_required",
      };
    }

    if (
      !payload ||
      !(await verifyAppointmentCancellationCalendarAuthorization({
        db,
        payload,
        appointmentId,
        requestedVersion,
        requestedCalendarEventId,
      }))
    ) {
      return {
        status: "skipped",
        error: "calendar_cancel_not_explicitly_authorized",
      };
    }

    const deleted = await deleteCalendarEvent(requestedCalendarEventId);
    if (!deleted) throw new Error("calendar_delete_unconfirmed");
    const cleared = await db
      .update(appointments)
      .set({
        calendarEventId: null,
        // Provider bookkeeping belongs to the status mutation's version.
        updatedAt: appointment.updatedAt,
      })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.status, "canceled"),
          eq(appointments.calendarEventId, requestedCalendarEventId),
          eq(appointments.updatedAt, appointment.updatedAt),
        ),
      )
      .returning({ id: appointments.id });
    if (cleared.length !== 1) {
      throw new Error("calendar_state_changed_after_provider_delete");
    }
    await recordCalendarSyncOutcomeOnce({
      outboxEventId: event.id,
      appointmentId,
      action: "appointment.calendar_sync.succeeded",
      outcome: "succeeded",
      correlationId,
      version: requestedVersion,
      status: appointment.status,
      syncReason,
      providerEventId: requestedCalendarEventId,
    });
    return { status: "processed" };
  }

  if (!appointment.startAt) {
    throw new Error("calendar_sync_payload_unavailable");
  }

  const contactName = [
    readStringValue(appointment.contactFirstName),
    readStringValue(appointment.contactLastName),
  ]
    .filter((part): part is string => part !== null)
    .join(" ")
    .trim();
  const rescheduleToken = readStringValue(appointment.rescheduleToken);
  const rescheduleUrl = rescheduleToken
    ? (buildRescheduleUrlForAppointment(appointmentId, rescheduleToken) ??
      undefined)
    : undefined;
  const calendarPayload: AppointmentCalendarPayload = {
    appointmentId,
    startAt: appointment.startAt,
    durationMinutes: appointment.durationMinutes,
    travelBufferMinutes: appointment.travelBufferMinutes,
    services: coerceServices(appointment.leadServices),
    notes:
      typeof appointment.leadNotes === "string" ? appointment.leadNotes : null,
    contact: {
      name: contactName || "Stonegate Customer",
      email: readStringValue(appointment.contactEmail),
      phone:
        readStringValue(appointment.contactPhoneE164) ??
        readStringValue(appointment.contactPhone),
    },
    property: {
      addressLine1:
        readStringValue(appointment.propertyAddressLine1) ??
        "Undisclosed address",
      city: readStringValue(appointment.propertyCity) ?? "",
      state: readStringValue(appointment.propertyState) ?? "",
      postalCode: readStringValue(appointment.propertyPostalCode) ?? "",
    },
    ...(rescheduleUrl ? { rescheduleUrl } : {}),
  };

  let providerEventId: string;
  if (appointment.calendarEventId) {
    providerEventId = appointment.calendarEventId;
    const updated = await updateCalendarEventWithRetry(
      providerEventId,
      calendarPayload,
    );
    if (!updated) {
      // The provider may have accepted the update even when the response was
      // lost. Retrying the same ID is safe; creating here could duplicate it.
      throw new Error("calendar_sync_existing_update_unconfirmed");
    }
  } else {
    const createdEventId = await createCalendarEventWithRetry(calendarPayload);
    if (!createdEventId) {
      throw new Error("calendar_sync_provider_unconfirmed");
    }
    providerEventId = createdEventId;
  }

  if (providerEventId !== appointment.calendarEventId) {
    const currentCalendarPredicate = appointment.calendarEventId
      ? eq(appointments.calendarEventId, appointment.calendarEventId)
      : isNull(appointments.calendarEventId);
    const changed = await db
      .update(appointments)
      .set({
        calendarEventId: providerEventId,
        // Provider bookkeeping belongs to the conversion version and must not
        // make an already-rendered If-Match stale.
        updatedAt: appointment.updatedAt,
      })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.updatedAt, appointment.updatedAt),
          currentCalendarPredicate,
        ),
      )
      .returning({ id: appointments.id });
    if (changed.length !== 1) {
      await recordCalendarSyncOutcomeOnce({
        outboxEventId: event.id,
        appointmentId,
        action: "appointment.calendar_sync.reconciliation_required",
        outcome: "failed",
        correlationId,
        version: requestedVersion,
        status: appointment.status,
        syncReason,
        providerEventId,
        reason: "appointment_changed_after_provider_success",
      });
      return {
        status: "skipped",
        error: "calendar_sync_storage_reconciliation_required",
      };
    }
  }

  await recordCalendarSyncOutcomeOnce({
    outboxEventId: event.id,
    appointmentId,
    action: "appointment.calendar_sync.succeeded",
    outcome: "succeeded",
    correlationId,
    version: requestedVersion,
    status: appointment.status,
    syncReason,
    providerEventId,
  });
  return { status: "processed" };
}

async function handleOutboxEvent(
  event: OutboxEventRecord,
): Promise<OutboxOutcome> {
  switch (event.type) {
    case "partner.account_invitation.email": {
      if (getTeamOperationKillSwitchForRisk("external") === "external_sends") {
        return {
          status: "retry",
          error: "partner_invitation_external_sends_disabled",
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
        };
      }
      const payload = isRecord(event.payload) ? event.payload : null;
      const invitationId = readStringValue(payload?.["invitationId"]);
      const deliveryUrl = readStringValue(payload?.["deliveryUrl"]);
      const correlationId = readStringValue(payload?.["correlationId"]);
      const generation = payload?.["generation"];
      if (
        !invitationId ||
        !deliveryUrl ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation < 1
      ) {
        return { status: "skipped", error: "partner_invitation_payload_invalid" };
      }
      return processPartnerAccountInvitationEmail({
        invitationId,
        generation,
        outboxEventId: event.id,
        deliveryUrl,
        correlationId,
      });
    }

    case "expense.receipt.analyze": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const captureId = readStringValue(payload?.["captureId"]);
      if (!captureId) {
        return {
          status: "skipped",
          error: "expense_receipt_capture_id_missing",
        };
      }
      return processExpenseReceiptAnalysisOutbox({
        captureId,
        priorAttempts: event.attempts ?? 0,
      });
    }

    case "staff_notification.dispatch": {
      if (getTeamOperationKillSwitchForRisk("external") === "external_sends") {
        return {
          status: "retry",
          error: "staff_notification_external_sends_disabled",
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
        };
      }
      const payload = isRecord(event.payload) ? event.payload : null;
      const operationId = readStringValue(payload?.["operationId"]);
      if (!operationId) {
        return {
          status: "skipped",
          error: "staff_notification_operation_missing",
        };
      }

      const db = getDb();
      const prepared = await db.transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId,
          outboxEventId: event.id,
        }),
      );
      if (prepared.kind === "unavailable") {
        return {
          status: "skipped",
          error: "staff_notification_operation_unavailable",
        };
      }
      if (prepared.kind === "terminal") {
        return { status: "processed" };
      }
      if (prepared.kind === "in_flight") {
        return {
          status: "retry",
          error: "staff_notification_provider_effect_pending",
          nextAttemptAt: prepared.retryAt,
        };
      }

      const result = await sendSmsMessage(
        prepared.operation.recipientAddress,
        prepared.operation.body,
        null,
        { idempotencyKey: prepared.operation.providerRequestKey },
      );
      const finalized = await db.transaction((tx) =>
        finalizeStaffNotificationDispatch(tx, {
          operationId,
          outboxEventId: event.id,
          result,
        }),
      );
      if (finalized.kind === "retry") {
        return {
          status: "retry",
          error: finalized.error,
          nextAttemptAt: finalized.retryAt,
        };
      }
      return { status: "processed" };
    }

    case "partner.cancellation_review_requested": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const partnerAccountId = readStringValue(payload?.["partnerAccountId"]);
      const partnerBookingId = readStringValue(payload?.["partnerBookingId"]);
      const appointmentId = readStringValue(payload?.["appointmentId"]);
      const partnerJobEventId = readStringValue(payload?.["partnerJobEventId"]);
      if (
        !partnerAccountId ||
        !partnerBookingId ||
        !appointmentId ||
        !partnerJobEventId
      ) {
        return {
          status: "skipped",
          error: "partner_cancellation_review_context_missing",
        };
      }

      const db = getDb();
      const result = await db.transaction(async (tx) => {
        const [request] = await tx
          .select({
            bookingId: partnerBookings.id,
            appointmentId: partnerBookings.appointmentId,
          })
          .from(partnerBookings)
          .innerJoin(
            partnerJobEvents,
            and(
              eq(partnerJobEvents.id, partnerJobEventId),
              eq(
                partnerJobEvents.partnerAccountId,
                partnerBookings.partnerAccountId,
              ),
              eq(partnerJobEvents.partnerBookingId, partnerBookings.id),
              eq(
                partnerJobEvents.eventType,
                "job.cancellation_review_requested",
              ),
            ),
          )
          .where(
            and(
              eq(partnerBookings.id, partnerBookingId),
              eq(partnerBookings.partnerAccountId, partnerAccountId),
              eq(partnerBookings.appointmentId, appointmentId),
              ne(partnerBookings.publicStatus, "canceled"),
              isNotNull(partnerBookings.cancelOperationKeyHash),
              isNotNull(partnerBookings.cancelRequestHash),
            ),
          )
          .limit(1);
        if (!request) return { kind: "unavailable" as const };

        const title = `Review partner cancellation request · job ${partnerBookingId
          .slice(0, 8)
          .toUpperCase()}`;
        const [existing] = await tx
          .select({ id: appointmentTasks.id })
          .from(appointmentTasks)
          .where(
            and(
              eq(appointmentTasks.appointmentId, appointmentId),
              eq(appointmentTasks.status, "open"),
              eq(appointmentTasks.title, title),
            ),
          )
          .limit(1);
        if (existing) return { kind: "existing" as const };

        await tx.insert(appointmentTasks).values({
          appointmentId,
          title,
          status: "open",
        });
        return { kind: "created" as const };
      });

      if (result.kind === "unavailable") {
        return {
          status: "skipped",
          error: "partner_cancellation_review_no_longer_pending",
        };
      }
      if (result.kind === "created") {
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "partner.booking.cancellation_review_task_created",
          entityType: "partner_booking",
          entityId: partnerBookingId,
          meta: {
            partnerAccountId,
            appointmentId,
            partnerJobEventId,
            outboxEventId: event.id,
          },
        });
      }
      return { status: "processed" };
    }

    case "appointment.calendar_sync_requested":
      return handleAppointmentCalendarSyncRequested(event);

    case "appointment_media.import_message": {
      if (!isMediaAutoImportEnabled()) {
        return {
          status: "quarantined",
          error: "media_auto_import_disabled",
          quarantineReason: "media_auto_import_disabled",
        };
      }
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId = readStringValue(payload?.["messageId"]);
      if (!messageId) return { status: "skipped" };
      try {
        await importConversationMessageMedia(messageId);
        return { status: "processed" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return error instanceof AppointmentMediaError && error.status < 500
          ? { status: "processed", error: detail }
          : {
              status: "retry",
              error: detail,
              maxAttempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS,
              quarantineReason: "appointment_media_retry_budget_exhausted",
            };
      }
    }

    case "appointment_media.attach_appointment": {
      if (!isMediaAutoImportEnabled()) {
        return {
          status: "quarantined",
          error: "media_auto_import_disabled",
          quarantineReason: "media_auto_import_disabled",
        };
      }
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentId = readStringValue(payload?.["appointmentId"]);
      if (!appointmentId) return { status: "skipped" };
      try {
        await importAppointmentRelatedMedia(appointmentId);
        return { status: "processed" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return error instanceof AppointmentMediaError && error.status < 500
          ? { status: "processed", error: detail }
          : {
              status: "retry",
              error: detail,
              maxAttempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS,
              quarantineReason: "appointment_media_retry_budget_exhausted",
            };
      }
    }

    case "facebook.dm.inbound": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const senderId = readStringValue(payload?.["senderId"]);
      if (!senderId) {
        console.warn("[outbox] facebook.dm.inbound.missing_sender", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const pageId = readStringValue(payload?.["pageId"]);
      const recipientId = readStringValue(payload?.["recipientId"]);
      const body = readStringValue(payload?.["body"]) ?? "";
      const providerMessageId = readStringValue(payload?.["providerMessageId"]);
      const timestampValue = readStringValue(payload?.["timestamp"]);
      const receivedAt = timestampValue ? new Date(timestampValue) : undefined;
      const mediaUrls = Array.isArray(payload?.["mediaUrls"])
        ? payload?.["mediaUrls"].filter(
            (url): url is string =>
              typeof url === "string" && url.trim().length > 0,
          )
        : [];
      const senderName = await fetchFacebookSenderName(pageId, senderId);

      await recordInboundMessage({
        channel: "dm",
        body,
        subject: null,
        fromAddress: senderId,
        toAddress: recipientId,
        provider: "facebook",
        providerMessageId,
        mediaUrls,
        receivedAt:
          receivedAt && !Number.isNaN(receivedAt.getTime())
            ? receivedAt
            : undefined,
        senderName: senderName ?? null,
        metadata: {
          source: "facebook",
          pageId,
          senderId,
          recipientId,
        },
      });

      return { status: "processed" };
    }

    case "facebook.dm.postback": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const senderId = readStringValue(payload?.["senderId"]);
      if (!senderId) {
        console.warn("[outbox] facebook.dm.postback.missing_sender", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const pageId = readStringValue(payload?.["pageId"]);
      const recipientId = readStringValue(payload?.["recipientId"]);
      const timestampValue = readStringValue(payload?.["timestamp"]);
      const receivedAt = timestampValue ? new Date(timestampValue) : undefined;
      const postbackPayload = readStringValue(payload?.["payload"]);
      const title = readStringValue(payload?.["title"]);
      const referral =
        payload?.["referral"] && isRecord(payload["referral"])
          ? payload["referral"]
          : null;
      const senderName = await fetchFacebookSenderName(pageId, senderId);
      const body = postbackPayload
        ? `Postback: ${postbackPayload}`
        : title
          ? `Postback: ${title}`
          : "Postback received";

      await recordInboundMessage({
        channel: "dm",
        body,
        subject: null,
        fromAddress: senderId,
        toAddress: recipientId,
        provider: "facebook",
        providerMessageId: null,
        receivedAt:
          receivedAt && !Number.isNaN(receivedAt.getTime())
            ? receivedAt
            : undefined,
        senderName: senderName ?? null,
        metadata: {
          source: "facebook",
          type: "postback",
          pageId,
          senderId,
          recipientId,
          payload: postbackPayload,
          title,
          referral,
        },
      });

      return { status: "processed" };
    }

    case "facebook.leadgen.created": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadgenId = readStringValue(payload?.["leadgenId"]);
      if (!leadgenId) {
        console.warn("[outbox] facebook.leadgen.created.missing_leadgen", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const pageId = readStringValue(payload?.["pageId"]);
      const formId = readStringValue(payload?.["formId"]);
      const details = await fetchFacebookLeadgenDetails(leadgenId, { pageId });
      const result = await recordLeadFromFacebook({
        leadgenId,
        formId,
        pageId,
        details,
      });

      if (!result.duplicate) {
        console.info("[outbox] facebook.leadgen.recorded", {
          leadId: result.leadId,
          leadgenId,
          formId,
        });
      }

      return { status: "processed" };
    }

    case "estimate.requested": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentIdValue = payload?.["appointmentId"];
      const appointmentId =
        typeof appointmentIdValue === "string" ? appointmentIdValue : null;
      if (!appointmentId) {
        console.warn("[outbox] estimate.requested.missing_appointment", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const db = getDb();
      if (isMediaAutoImportEnabled()) {
        const [existingMediaImport] = await db
          .select({ id: outboxEvents.id })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.type, "appointment_media.attach_appointment"),
              sql`(${outboxEvents.payload} ->> 'appointmentId') = ${appointmentId}`,
            ),
          )
          .limit(1);
        if (!existingMediaImport) {
          await db.insert(outboxEvents).values({
            type: "appointment_media.attach_appointment",
            payload: { appointmentId },
          });
        }
      }

      const services = coerceServices(payload?.["services"]);
      const schedulingOverride =
        payload && isRecord(payload["scheduling"])
          ? payload["scheduling"]
          : null;
      const customerPhone =
        typeof payload?.["customerPhone"] === "string"
          ? payload["customerPhone"]
          : null;
      const customerName =
        typeof payload?.["customerName"] === "string"
          ? payload["customerName"]
          : null;
      const customerEmail =
        typeof payload?.["customerEmail"] === "string"
          ? payload["customerEmail"]
          : null;

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
                  : undefined,
            }
          : undefined,
        notes:
          typeof payload?.["notes"] === "string" ? payload["notes"] : undefined,
        contact:
          customerPhone || customerName || customerEmail
            ? {
                phone: customerPhone ?? undefined,
                name: customerName ?? undefined,
                email: customerEmail ?? undefined,
              }
            : undefined,
      });

      if (!notification) {
        return { status: "skipped" };
      }

      if (notification.appointment.status === "canceled") {
        console.info("[outbox] estimate.requested.already_canceled", {
          id: event.id,
          appointmentId,
        });
        await clearPendingReminders(appointmentId);
        return { status: "processed" };
      }

      await ensureCalendarEventCreated(notification);
      await sendEstimateConfirmation(notification, "requested", event.id);
      await scheduleAppointmentReminders(
        appointmentId,
        notification.appointment.startAt,
      );
      await clearLeadFollowups(notification.leadId ?? null);
      if (notification.contactId) {
        await completeSalesTasksForContact(
          getDb(),
          notification.contactId,
          new Date(),
        );
      }
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "qualified",
        "estimate.requested",
        { appointmentId },
      );

      try {
        const contactId =
          typeof notification.contactId === "string"
            ? notification.contactId
            : null;
        const startAt = notification.appointment.startAt;
        if (contactId && startAt instanceof Date) {
          const db = getDb();
          const config = await getSalesScorecardConfig(db);
          const [contactRow] = await db
            .select({ salespersonMemberId: contacts.salespersonMemberId })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1);

          const memberId =
            contactRow?.salespersonMemberId ?? config.defaultAssigneeMemberId;
          const phoneMap = await getTeamMemberPhoneMap(db);
          const recipient = phoneMap[memberId] ?? null;
          if (recipient) {
            const business = await getBusinessHoursPolicy(db);
            const whenLabel = formatReminderDueAt(startAt, business.timezone);
            const contactPhone = notification.contact.phone
              ? ` (${notification.contact.phone})`
              : "";
            const message = `New booking: ${notification.contact.name}${contactPhone}\nWhen: ${whenLabel}`;
            const result = await sendSmsMessage(recipient, message);
            if (result.ok) {
              await recordProviderSuccessSafe("sms");
              await recordAuditEvent({
                actor: { type: "worker", label: "outbox" },
                action: "sales.booking_alert.sent",
                entityType: "appointment",
                entityId: appointmentId,
                meta: {
                  recipient,
                  contactId,
                  provider: result.provider ?? null,
                },
              });
            } else {
              const detail = result.detail ?? "booking_alert_failed";
              await recordProviderFailureSafe("sms", detail);
              await recordAuditEvent({
                actor: { type: "worker", label: "outbox" },
                action: "sales.booking_alert.failed",
                entityType: "appointment",
                entityId: appointmentId,
                meta: {
                  recipient,
                  contactId,
                  provider: result.provider ?? null,
                  detail,
                },
              });
            }
          }
        }
      } catch (error) {
        console.warn("[outbox] sales.booking_alert.error", {
          appointmentId,
          error: String(error),
        });
      }

      return { status: "processed" };
    }

    case "estimate.rescheduled": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentIdValue = payload?.["appointmentId"];
      const appointmentId =
        typeof appointmentIdValue === "string" ? appointmentIdValue : null;
      if (!appointmentId) {
        console.warn("[outbox] estimate.rescheduled.missing_appointment", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const customerPhone =
        typeof payload?.["customerPhone"] === "string"
          ? payload["customerPhone"]
          : null;
      const customerName =
        typeof payload?.["customerName"] === "string"
          ? payload["customerName"]
          : null;
      const customerEmail =
        typeof payload?.["customerEmail"] === "string"
          ? payload["customerEmail"]
          : null;
      const notification = await buildNotificationPayload(appointmentId, {
        services: coerceServices(payload?.["services"]),
        rescheduleUrl:
          typeof payload?.["rescheduleUrl"] === "string"
            ? payload["rescheduleUrl"]
            : undefined,
        contact:
          customerPhone || customerName || customerEmail
            ? {
                phone: customerPhone ?? undefined,
                name: customerName ?? undefined,
                email: customerEmail ?? undefined,
              }
            : undefined,
      });

      if (!notification) {
        return { status: "skipped" };
      }

      await syncCalendarEventForReschedule(notification);
      await sendEstimateConfirmation(notification, "rescheduled", event.id);
      await scheduleAppointmentReminders(
        appointmentId,
        notification.appointment.startAt,
        { reset: true },
      );
      await clearLeadFollowups(notification.leadId ?? null);
      if (notification.contactId) {
        await completeSalesTasksForContact(
          getDb(),
          notification.contactId,
          new Date(),
        );
      }
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "qualified",
        "estimate.rescheduled",
        { appointmentId },
      );
      return { status: "processed" };
    }

    case "quote.sent": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const quoteId =
        typeof payload?.["quoteId"] === "string" ? payload["quoteId"] : null;
      if (!quoteId) {
        console.warn("[outbox] quote.sent.missing_id", { id: event.id });
        return { status: "skipped" };
      }

      const sendAttemptId = resolveQuoteSendAttemptId(
        payload?.["sendAttemptId"],
        event.id,
      );

      const notification = await buildQuoteNotificationPayload(quoteId);
      if (!notification) {
        return { status: "skipped" };
      }

      await sendQuoteSentNotification({ ...notification, sendAttemptId });
      await updatePipelineStageForContact(
        notification.contactId ?? null,
        "quoted",
        "quote.sent",
        { quoteId },
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

    case "quote.send_requested.v2":
      return processQuoteV2SendRequestedOutbox(event);

    case "quote.change_requested.v2":
    case "quote.response_recorded.v2":
    case "quote.deposit_checkout_requested.v2":
    case "quote.accepted_and_booked.v2":
      return processQuoteV2WorkflowOutbox(event);

    case "quote.decision": {
      const decisionPayload = parseQuoteDecisionOutboxPayload(event.payload);
      if (!decisionPayload) {
        console.warn("[outbox] quote.decision.missing_data", { id: event.id });
        return {
          status: "skipped",
          error: "invalid_quote_decision_payload_or_source",
        };
      }
      const { quoteId, decision, source, notes } = decisionPayload;
      const contactId = await loadQuoteWorkflowContactId(quoteId);
      if (!contactId) {
        return { status: "skipped" };
      }
      const targetStage: PipelineStage =
        decision === "accepted" ? "won" : "lost";
      await updatePipelineStageForContact(
        contactId,
        targetStage,
        "quote.decision",
        { quoteId, decision, source },
      );
      const db = getDb();
      const [leadRow] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.contactId, contactId))
        .orderBy(desc(leads.updatedAt), desc(leads.createdAt))
        .limit(1);
      await clearLeadFollowups(leadRow?.id ?? null);

      if (shouldNotifyCustomerForQuoteDecision(source)) {
        const notification = await buildQuoteNotificationPayload(quoteId, {
          notes,
        });
        if (!notification) {
          return {
            status: "skipped",
            error: "quote_decision_notification_unavailable",
          };
        }
        await sendQuoteDecisionNotification({
          ...notification,
          decision,
          source: "customer",
        });
      }
      return { status: "processed" };
    }

    case "estimate.status_changed":
    case "lead.created": {
      const payload = isRecord(event.payload) ? event.payload : null;
      let leadId =
        typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const appointmentIdFromPayload =
        typeof payload?.["appointmentId"] === "string"
          ? payload["appointmentId"]
          : null;
      const status =
        typeof payload?.["status"] === "string" ? payload["status"] : null;
      const eventVersion = readStringValue(payload?.["version"]);
      // Legacy events did not carry statusChanged, so their internal CRM
      // reconciliation remains intact. Customer messaging has a separate,
      // fail-closed authorization gate below. Conversion events can explicitly
      // identify a real lifecycle transition without pretending their generic
      // status notification was approved.
      const shouldApplyInternalStatusEffects =
        event.type !== "estimate.status_changed" ||
        payload?.["statusChanged"] !== false ||
        payload?.["lifecycleStatusChanged"] === true;
      const services = coerceServices(payload?.["services"]);
      const schedulingOverride =
        payload && isRecord(payload["scheduling"])
          ? payload["scheduling"]
          : null;

      const db = getDb();
      const rows = appointmentIdFromPayload
        ? await db
            .select({
              id: appointments.id,
              leadId: appointments.leadId,
              contactId: appointments.contactId,
              status: appointments.status,
              calendarEventId: appointments.calendarEventId,
              updatedAt: appointments.updatedAt,
            })
            .from(appointments)
            .where(eq(appointments.id, appointmentIdFromPayload))
            .limit(1)
        : leadId
          ? await db
              .select({
                id: appointments.id,
                leadId: appointments.leadId,
                contactId: appointments.contactId,
                status: appointments.status,
                calendarEventId: appointments.calendarEventId,
                updatedAt: appointments.updatedAt,
              })
              .from(appointments)
              .where(eq(appointments.leadId, leadId))
              .limit(1)
          : [];

      const appointment = rows[0];
      if (!appointment?.id) {
        // Appointmentless web leads are valid. Their durable lead.alert event
        // owns staff notification and follow-up scheduling, so this domain
        // event has completed without an appointment-specific side effect.
        if (event.type === "lead.created") {
          return { status: "processed" };
        }
        console.info("[outbox] appointment_notification.no_appointment", {
          id: event.id,
        });
        return { status: "skipped" };
      }
      leadId = leadId ?? appointment.leadId ?? null;

      if (
        event.type === "estimate.status_changed" &&
        status &&
        appointment.status !== status
      ) {
        console.info("[outbox] appointment_notification.superseded", {
          id: event.id,
          appointmentId: appointment.id,
        });
        return { status: "skipped" };
      }

      if (!shouldApplyInternalStatusEffects) {
        return { status: "processed" };
      }

      if (
        status === "canceled" ||
        status === "no_show" ||
        status === "completed"
      ) {
        await clearPendingReminders(appointment.id);
      }
      if (event.type === "estimate.status_changed") {
        await clearLeadFollowups(leadId);
      }
      if (appointment.contactId) {
        await completeSalesTasksForContact(
          db,
          appointment.contactId,
          new Date(),
        );
      }
      if (appointment.contactId) {
        const targetStage: PipelineStage =
          event.type === "estimate.status_changed" && status
            ? mapAppointmentStatusToStage(status)
            : "qualified";
        await updatePipelineStageForContact(
          appointment.contactId,
          targetStage,
          event.type,
          {
            appointmentId: appointment.id,
            status: status ?? null,
          },
        );
      }

      const statusNotificationRequested =
        event.type === "estimate.status_changed" &&
        payload?.["customerNotificationRequested"] === true;
      const authorization =
        event.type === "estimate.status_changed"
          ? await verifyAppointmentMessageAuthorization({
              db,
              payload,
              appointmentId: appointment.id,
              status,
              intent: "status_notification",
              requested: statusNotificationRequested,
            })
          : null;
      if (authorization?.state === "invalid") {
        console.warn(
          "[outbox] appointment_notification.authorization_invalid",
          { id: event.id, appointmentId: appointment.id },
        );
        return {
          status: "processed",
          error: "status_notification_not_explicitly_authorized",
        };
      }
      if (
        event.type === "estimate.status_changed" &&
        authorization?.state === "not_requested"
      ) {
        return { status: "processed" };
      }
      if (event.type === "estimate.status_changed" && status !== "canceled") {
        return {
          status: "processed",
          error: "status_notification_status_not_supported",
        };
      }
      if (
        event.type === "estimate.status_changed" &&
        eventVersion &&
        appointment.updatedAt.toISOString() !== eventVersion
      ) {
        return {
          status: "processed",
          error: "status_notification_state_changed",
        };
      }
      if (getTeamOperationKillSwitchForRisk("external") === "external_sends") {
        return {
          status: "retry",
          error: "appointment_notification_external_sends_disabled",
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
        };
      }
      if (!leadId) {
        console.info("[outbox] appointment_notification.no_lead", {
          id: event.id,
          appointmentId: appointment.id,
        });
        return { status: "processed" };
      }

      /* The row above deliberately resolves by the event's appointment ID
       * when present. This prevents a reused lead from moving an old status
       * event onto a different appointment. */
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
                  : undefined,
            }
          : undefined,
        notes:
          typeof payload?.["notes"] === "string" ? payload["notes"] : undefined,
      });
      if (!notification) return { status: "skipped" };

      if (event.type === "estimate.status_changed") {
        if (authorization?.state !== "authorized") {
          return {
            status: "processed",
            error: "status_notification_not_explicitly_authorized",
          };
        }
        if (!notification.contactId) {
          return {
            status: "skipped",
            error: "status_notification_contact_missing",
          };
        }
        await sendEstimateCancellation(
          notification,
          authorization.evidence.operationId,
          {
            sourceStatusOutboxEventId: event.id,
            sourceStatusAuditEventId: authorization.evidence.auditEventId,
            sourceCorrelationId: authorization.evidence.correlationId,
            sourceOperationId: authorization.evidence.operationId,
            sourceActorId: authorization.evidence.actorId,
            sourceAuthMethod: authorization.evidence.authMethod,
            sourceRequiredPermission: authorization.evidence.requiredPermission,
          },
        );
      } else {
        await sendEstimateConfirmation(notification, "requested", event.id);
      }
      return { status: "processed" };
    }

    case "review.request": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentId =
        typeof payload?.["appointmentId"] === "string"
          ? payload["appointmentId"]
          : null;
      const status = readStringValue(payload?.["status"]);
      const requested = payload?.["requested"] === true;
      if (!appointmentId || !status) {
        console.warn("[outbox] review.request.missing_appointment", {
          id: event.id,
        });
        return { status: "skipped" };
      }
      if (status !== "completed") {
        return {
          status: "skipped",
          error: "review_request_status_not_supported",
        };
      }

      const db = getDb();
      const authorization = await verifyAppointmentMessageAuthorization({
        db,
        payload,
        appointmentId,
        status,
        intent: "review_request",
        requested,
      });
      if (authorization.state !== "authorized") {
        console.warn("[outbox] review.request.authorization_invalid", {
          id: event.id,
          appointmentId,
          authorizationState: authorization.state,
        });
        return {
          status: "skipped",
          error: "review_request_not_explicitly_authorized",
        };
      }
      if (getTeamOperationKillSwitchForRisk("external") === "external_sends") {
        return {
          status: "retry",
          error: "review_request_external_sends_disabled",
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
        };
      }
      const policy = await getReviewRequestPolicy(db);
      if (!policy.enabled) {
        return { status: "processed" };
      }

      const reviewUrl = policy.reviewUrl.trim();
      if (!reviewUrl) {
        console.warn("[outbox] review.request.missing_url", {
          id: event.id,
          appointmentId,
        });
        return { status: "skipped" };
      }

      const [row] = await db
        .select({
          appointmentId: appointments.id,
          appointmentStatus: appointments.status,
          appointmentUpdatedAt: appointments.updatedAt,
          contactId: appointments.contactId,
          contactPhoneE164: contacts.phoneE164,
        })
        .from(appointments)
        .innerJoin(contacts, eq(appointments.contactId, contacts.id))
        .where(eq(appointments.id, appointmentId))
        .limit(1);

      if (!row) {
        console.warn("[outbox] review.request.not_found", {
          id: event.id,
          appointmentId,
        });
        return { status: "skipped" };
      }
      const requestedVersion = readStringValue(payload?.["version"]);
      if (
        !requestedVersion ||
        row.appointmentStatus !== "completed" ||
        row.appointmentUpdatedAt.toISOString() !== requestedVersion
      ) {
        return {
          status: "skipped",
          error: "review_request_state_changed",
        };
      }

      const contactPhone =
        typeof row.contactPhoneE164 === "string"
          ? row.contactPhoneE164.trim()
          : "";
      if (!contactPhone) {
        console.info("[outbox] review.request.no_phone", {
          id: event.id,
          appointmentId,
          contactId: row.contactId,
        });
        return { status: "skipped" };
      }

      const templates = await getTemplatesPolicy(db);
      const base =
        resolveTemplateForChannel(templates.reviews, {
          inboundChannel: "sms",
          replyChannel: "sms",
        }) ?? "Thanks for choosing Stonegate! Would you leave a quick review?";
      const body = base.includes(reviewUrl) ? base : `${base} ${reviewUrl}`;

      // Message creation and its provider-dispatch event commit atomically.
      // Retrying this review event after any later failure resolves the same
      // operation key instead of creating another customer effect.
      const messageId = await queueSystemOutboundMessage({
        contactId: row.contactId,
        channel: "sms",
        toAddress: contactPhone,
        body,
        dedupeKey: `appointment.review-request:${appointmentId}:${authorization.evidence.operationId}`,
        metadata: {
          reviewRequestAppointmentId: appointmentId,
          messageKind: "review_request",
          reviewRequestOutboxEventId: event.id,
          sourceStatusAuditEventId: authorization.evidence.auditEventId,
          sourceCorrelationId: authorization.evidence.correlationId,
          sourceOperationId: authorization.evidence.operationId,
          sourceActorId: authorization.evidence.actorId,
          sourceAuthMethod: authorization.evidence.authMethod,
          sourceRequiredPermission: authorization.evidence.requiredPermission,
        },
      });

      if (!messageId) {
        console.warn("[outbox] review.request.queue_failed", {
          id: event.id,
          appointmentId,
          contactId: row.contactId,
        });
        return { status: "skipped" };
      }

      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "review.request.queued",
        entityType: "appointment",
        entityId: appointmentId,
        meta: {
          contactId: row.contactId,
          messageId,
          reviewRequestOutboxEventId: event.id,
          sourceStatusAuditEventId: authorization.evidence.auditEventId,
          correlationId: authorization.evidence.correlationId,
          operationId: authorization.evidence.operationId,
        },
      });

      return { status: "processed" };
    }

    case "lead.alert": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId =
        typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      if (!leadId) {
        console.warn("[outbox] lead.alert.missing_lead", { id: event.id });
        return { status: "skipped" };
      }

      const db = getDb();
      await ensureSalesFollowupsForLead({
        db,
        leadId,
        outboxEventId: event.id,
        payload,
      });
      const payloadAfterFollowups: Record<string, unknown> = {
        ...(payload ?? {}),
        scheduledSalesFollowups: true,
      };

      try {
        const [leadRow] = await db
          .select({
            contactId: leads.contactId,
            propertyId: leads.propertyId,
            city: properties.city,
            postalCode: properties.postalCode,
          })
          .from(leads)
          .leftJoin(properties, eq(leads.propertyId, properties.id))
          .where(eq(leads.id, leadId))
          .limit(1);
        if (leadRow?.contactId) {
          await queueAutoFirstTouchSms({
            db,
            contactId: leadRow.contactId,
            leadId,
            leadPropertyId: leadRow.propertyId ?? null,
            propertyCity: leadRow.city ?? null,
            propertyPostalCode: leadRow.postalCode ?? null,
          });
        }
      } catch (error) {
        console.warn("[outbox] lead.alert.first_touch_failed", {
          leadId,
          error: String(error),
        });
      }

      const recipients = parseLeadAlertRecipients(
        process.env["LEAD_ALERT_SMS"],
      );
      if (!recipients.length) {
        return { status: "processed" };
      }

      const message = await buildLeadAlertMessage(leadId);
      if (!message) {
        return { status: "skipped" };
      }

      const sentTo = Array.isArray(payloadAfterFollowups["sentTo"])
        ? payloadAfterFollowups["sentTo"].filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const sentSet = new Set(sentTo);
      const pending = recipients.filter((recipient) => !sentSet.has(recipient));
      if (!pending.length) {
        return { status: "processed" };
      }

      let retryableFailure: string | null = null;
      let lastFailure: string | null = null;

      for (const recipient of pending) {
        const result = await sendSmsMessage(
          recipient,
          message.text,
          message.mediaUrls,
        );
        if (result.ok) {
          sentSet.add(recipient);
          await recordProviderSuccessSafe("sms");
          await recordAuditEvent({
            actor: { type: "worker", label: "outbox" },
            action: "lead.alert.sent",
            entityType: "lead",
            entityId: leadId,
            meta: { recipient, provider: result.provider ?? null },
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
          meta: { recipient, provider: result.provider ?? null, detail },
        });
      }

      const updatedPayload = {
        ...payloadAfterFollowups,
        sentTo: Array.from(sentSet),
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

    case "contact.alert": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const contactId =
        typeof payload?.["contactId"] === "string"
          ? payload["contactId"]
          : null;
      if (!contactId) {
        console.warn("[outbox] contact.alert.missing_contact", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const db = getDb();
      await ensureSalesFollowupsForContact({
        db,
        contactId,
        outboxEventId: event.id,
        payload,
      });

      try {
        await queueAutoFirstTouchSms({ db, contactId });
      } catch (error) {
        console.warn("[outbox] contact.alert.first_touch_failed", {
          contactId,
          error: String(error),
        });
      }

      return { status: "processed" };
    }

    case "sales.escalation.call": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const taskId =
        typeof payload?.["taskId"] === "string" ? payload["taskId"].trim() : "";
      const mode =
        typeof payload?.["mode"] === "string" ? payload["mode"].trim() : "";
      const isInstant = mode === "instant";
      if (!taskId) {
        console.warn("[outbox] sales.escalation.missing_task_id", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const db = getDb();
      // A committed provider-boundary operation owns the event from this
      // point forward. Resume it before consulting feature flags, kill
      // switches, or mutable task/contact state so accepted calls always
      // reach a terminal callback or explicit reconciliation without redial.
      const resumed = await resumeSalesEscalationCallAttempt({
        db,
        outboxEventId: event.id,
        taskId,
      });
      if (resumed?.kind === "settled") {
        if (resumed.retryAt) {
          return {
            status: "retry",
            error: resumed.error,
            nextAttemptAt: resumed.retryAt,
          };
        }
        return { status: "processed", error: resumed.error };
      }

      if (!SALES_ESCALATION_CALL_ENABLED) {
        return { status: "processed" };
      }
      if (getTeamOperationKillSwitch(["calls.place"])) {
        return {
          status: "retry",
          error: "external_sends_disabled",
          nextAttemptAt: new Date(Date.now() + 60_000),
        };
      }

      const [row] = await db
        .select({
          taskId: crmTasks.id,
          taskStatus: crmTasks.status,
          taskNotes: crmTasks.notes,
          taskDueAt: crmTasks.dueAt,
          taskCreatedAt: crmTasks.createdAt,
          taskUpdatedAt: crmTasks.updatedAt,
          contactId: crmTasks.contactId,
          assignedTo: crmTasks.assignedTo,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          contactDoNotContact: contacts.doNotContact,
          contactDeletedAt: contacts.deletedAt,
        })
        .from(crmTasks)
        .leftJoin(contacts, eq(crmTasks.contactId, contacts.id))
        .where(eq(crmTasks.id, taskId))
        .limit(1);

      if (!row?.taskId) {
        return { status: "processed" };
      }

      if (row.taskStatus !== "open" || !(row.taskDueAt instanceof Date)) {
        return { status: "processed" };
      }

      const contactId =
        typeof row.contactId === "string" ? row.contactId : null;
      if (!contactId || row.contactDeletedAt || row.contactDoNotContact) {
        return { status: "processed" };
      }

      const notes = typeof row.taskNotes === "string" ? row.taskNotes : "";
      if (!notes.includes("kind=speed_to_lead")) {
        return { status: "processed" };
      }

      const memberId =
        typeof row.assignedTo === "string" ? row.assignedTo : null;
      if (!memberId) {
        return { status: "processed" };
      }

      const now = new Date();
      const windowStart = nextSalesWindowStart(now);
      if (windowStart) {
        return {
          status: "retry",
          error: "outside_sales_hours",
          nextAttemptAt: windowStart,
        };
      }

      if (!isInstant && row.taskDueAt.getTime() > now.getTime()) {
        return {
          status: "retry",
          error: "not_due_yet",
          nextAttemptAt: row.taskDueAt,
        };
      }

      const customerPhone = normalizePhoneE164(
        row.phoneE164 ?? row.phone ?? "",
      );
      if (!customerPhone) {
        return { status: "processed" };
      }

      if (isInstant) {
        const [existingBooking] = await db
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.contactId, contactId),
              isNotNull(appointments.startAt),
              ne(appointments.status, "canceled"),
              gte(appointments.startAt, now),
            ),
          )
          .limit(1);
        if (existingBooking?.id) {
          return { status: "processed" };
        }
      }

      const [priorEscalation] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "sales.escalation.call.started"),
            eq(auditLogs.entityType, "crm_task"),
            eq(auditLogs.entityId, taskId),
          ),
        )
        .limit(1);
      if (priorEscalation?.id) {
        return { status: "processed" };
      }

      const [callTouch] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "call.started"),
            eq(auditLogs.outcome, "succeeded"),
            eq(auditLogs.entityType, "contact"),
            eq(auditLogs.entityId, contactId),
            eq(auditLogs.actorId, memberId),
          ),
        )
        .limit(1);

      if (callTouch?.id) {
        return { status: "processed" };
      }

      const [messageTouch] = await db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .innerJoin(
          conversationThreads,
          eq(conversationMessages.threadId, conversationThreads.id),
        )
        .innerJoin(
          conversationParticipants,
          eq(conversationMessages.participantId, conversationParticipants.id),
        )
        .where(
          and(
            eq(conversationThreads.contactId, contactId),
            eq(conversationMessages.direction, "outbound"),
            eq(conversationParticipants.participantType, "team"),
            eq(conversationParticipants.teamMemberId, memberId),
          ),
        )
        .limit(1);

      if (messageTouch?.id) {
        return { status: "processed" };
      }

      const taskCreatedAt =
        row.taskCreatedAt instanceof Date ? row.taskCreatedAt : null;
      if (taskCreatedAt) {
        const [inboundDm] = await db
          .select({ count: sql<number>`count(*)::int`.as("count") })
          .from(conversationMessages)
          .innerJoin(
            conversationThreads,
            eq(conversationMessages.threadId, conversationThreads.id),
          )
          .where(
            and(
              eq(conversationThreads.contactId, contactId),
              eq(conversationMessages.direction, "inbound"),
              eq(conversationMessages.channel, "dm"),
              gte(conversationMessages.createdAt, taskCreatedAt),
            ),
          );
        if ((inboundDm?.count ?? 0) >= 2) {
          return { status: "processed" };
        }
      }

      const [agent] = await db
        .select({
          phoneE164: teamMembers.phoneE164,
          active: teamMembers.active,
        })
        .from(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .limit(1);
      const agentPhone = normalizePhoneE164(agent?.phoneE164 ?? "");
      if (!agent?.active || !agentPhone) {
        console.warn("[outbox] sales.escalation.missing_agent_phone", {
          eventId: event.id,
        });
        return { status: "processed" };
      }

      let apiBaseUrl: string;
      try {
        apiBaseUrl = getTwilioWebhookPublicBaseUrl();
      } catch {
        console.warn(
          "[outbox] sales.escalation.twilio_webhook_configuration_unavailable",
        );
        return {
          status: "retry",
          error: "twilio_webhook_configuration_unavailable",
        };
      }

      const prepared = await prepareSalesEscalationCallAttempt({
        db,
        outboxEventId: event.id,
        taskId,
        taskUpdatedAt: row.taskUpdatedAt,
        contactId,
        agentMemberId: memberId,
        agentPhoneE164: agentPhone,
        customerPhoneE164: customerPhone,
        mode: isInstant ? "instant" : "scheduled",
      });
      if (prepared.kind === "settled") {
        if (prepared.retryAt) {
          return {
            status: "retry",
            error: prepared.error,
            nextAttemptAt: prepared.retryAt,
          };
        }
        return {
          status: "processed",
          error: prepared.error,
        };
      }

      const callbackUrl = buildTwilioWebhookUrl(
        "/api/webhooks/twilio/escalate",
        apiBaseUrl,
      );
      callbackUrl.searchParams.set("eventKey", event.id);
      callbackUrl.searchParams.set(
        "operationKey",
        prepared.operation.providerRequestKey,
      );

      const statusCallbackUrl = buildTwilioWebhookUrl(
        "/api/webhooks/twilio/call-status",
        apiBaseUrl,
      );
      statusCallbackUrl.searchParams.set("leg", "agent");
      statusCallbackUrl.searchParams.set("mode", "sales_escalation");
      statusCallbackUrl.searchParams.set("eventKey", event.id);
      statusCallbackUrl.searchParams.set(
        "operationKey",
        prepared.operation.providerRequestKey,
      );

      const result = await createTwilioOutboundCall({
        to: prepared.operation.agentPhoneE164,
        requestUrl: callbackUrl.toString(),
        statusCallbackUrl: statusCallbackUrl.toString(),
      });

      let finalized: Awaited<
        ReturnType<typeof finalizeSalesEscalationCallAttempt>
      >;
      try {
        finalized = await finalizeSalesEscalationCallAttempt({
          db,
          operationId: prepared.operation.id,
          providerResult: result,
        });
      } catch {
        try {
          await reconcileSalesEscalationAfterStorageFailure({
            db,
            operationId: prepared.operation.id,
            providerOperationId: result.ok ? result.callSid : null,
          });
        } catch (reconciliationError) {
          console.error("[outbox] sales.escalation.receipt_unavailable", {
            eventId: event.id,
            providerAccepted: result.ok,
            errorName:
              reconciliationError instanceof Error
                ? reconciliationError.name
                : "UnknownError",
          });
        }
        // Never finalize the outbox event while the operation receipt is
        // uncertain. A later run re-reads the durable `dispatched` marker,
        // moves it to reconciliation_required, and cannot call the provider
        // again. Marking this outbox row processed here could strand a
        // dispatched operation forever if the best-effort reconciliation
        // write above failed but the generic outbox update later succeeded.
        return {
          status: "retry",
          error: "sales_escalation_result_storage_failed",
          skipFinalization: true,
        };
      }

      if (finalized.state === "failed" && finalized.retryable) {
        return {
          status: "retry",
          error: finalized.error ?? "sales_escalation_not_dispatched",
        };
      }
      if (finalized.state === "succeeded" && finalized.retryAt) {
        return {
          status: "retry",
          error: "sales_escalation_callback_pending",
          nextAttemptAt: finalized.retryAt,
        };
      }
      return { status: "processed", error: finalized.error };
    }

    case "sales.queue.nudge.sms": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const taskId =
        typeof payload?.["taskId"] === "string" ? payload["taskId"].trim() : "";
      if (!taskId) {
        console.warn("[outbox] sales.queue_nudge.missing_task_id", {
          id: event.id,
        });
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
          phoneE164: contacts.phoneE164,
        })
        .from(crmTasks)
        .leftJoin(contacts, eq(crmTasks.contactId, contacts.id))
        .where(eq(crmTasks.id, taskId))
        .limit(1);

      if (!row?.id) {
        return { status: "processed" };
      }

      if (row.status !== "open" || !(row.dueAt instanceof Date)) {
        return { status: "processed" };
      }

      const notes = typeof row.notes === "string" ? row.notes : "";
      if (!notes.includes("kind=speed_to_lead")) {
        return { status: "processed" };
      }
      if (!SPEED_TO_LEAD_SLA_SMS_ENABLED) {
        console.info("[outbox] sales.queue_nudge.speed_to_lead_disabled", {
          id: event.id,
          taskId: row.id,
        });
        return { status: "processed" };
      }

      const now = new Date();
      const windowStart = nextSalesWindowStart(now);
      if (windowStart) {
        return {
          status: "retry",
          error: "outside_sales_hours",
          nextAttemptAt: windowStart,
        };
      }

      const [existingSent] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "sales.queue_nudge.sent"),
            eq(auditLogs.entityType, "crm_task"),
            eq(auditLogs.entityId, row.id),
          ),
        )
        .limit(1);
      if (existingSent?.id) {
        return { status: "processed" };
      }

      const phoneMap = await getTeamMemberPhoneMap(db);
      const recipient = row.assignedTo
        ? (phoneMap[row.assignedTo] ?? null)
        : null;
      if (!recipient) {
        console.warn("[outbox] sales.queue_nudge.missing_recipient", {
          id: event.id,
          taskId: row.id,
          assignedTo: row.assignedTo ?? null,
          phoneMapCount: Object.keys(phoneMap).length,
        });
        await recordProviderFailureSafe("sms", "missing_recipient");
        return { status: "processed", error: "missing_recipient" };
      }

      const business = await getBusinessHoursPolicy(db);
      const contactName =
        `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "New lead";
      const contactPhone = row.phoneE164 ?? row.phone ?? null;
      const dueLabel = formatReminderDueAt(row.dueAt, business.timezone);
      const contactLine = contactPhone ? ` (${contactPhone})` : "";

      const message = `New lead assigned: ${contactName}${contactLine}\n${row.title}\nDue: ${dueLabel}`;

      const result = await sendSmsMessage(recipient, message);
      if (result.ok) {
        await recordProviderSuccessSafe("sms");
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "sales.queue_nudge.sent",
          entityType: "crm_task",
          entityId: row.id,
          meta: {
            recipient,
            contactId: row.contactId,
            provider: result.provider ?? null,
          },
        });
        return { status: "processed" };
      }

      const detail = result.detail ?? "nudge_send_failed";
      const retryable = isRetryableSendFailure(detail);
      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "sales.queue_nudge.failed",
        entityType: "crm_task",
        entityId: row.id,
        meta: {
          recipient,
          contactId: row.contactId,
          provider: result.provider ?? null,
          detail,
        },
      });

      if (retryable) {
        return { status: "retry", error: detail };
      }

      await recordProviderFailureSafe("sms", detail);
      return { status: "processed", error: detail };
    }

    case "crm.reminder.sms": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const taskId =
        typeof payload?.["taskId"] === "string" ? payload["taskId"].trim() : "";
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
          phoneE164: contacts.phoneE164,
        })
        .from(crmTasks)
        .leftJoin(contacts, eq(crmTasks.contactId, contacts.id))
        .where(eq(crmTasks.id, taskId))
        .limit(1);

      if (!row) {
        console.info("[outbox] crm.reminder.task_not_found", {
          id: event.id,
          taskId,
        });
        return { status: "processed" };
      }

      const notes = typeof row.notes === "string" ? row.notes : "";
      if (notes.includes("kind=follow_up")) {
        console.info("[outbox] crm.reminder.follow_up_disabled", {
          id: event.id,
          taskId: row.id,
        });
        return { status: "processed" };
      }
      if (notes.includes("kind=speed_to_lead")) {
        if (!SPEED_TO_LEAD_SLA_SMS_ENABLED) {
          console.info("[outbox] crm.reminder.speed_to_lead_disabled", {
            id: event.id,
            taskId: row.id,
          });
          return { status: "processed" };
        }
      }

      if (row.status !== "open" || !row.dueAt) {
        console.info("[outbox] crm.reminder.not_open_or_missing_due", {
          id: event.id,
          taskId: row.id,
          status: row.status,
          dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        });
        return { status: "processed" };
      }

      const now = new Date();
      if (row.dueAt.getTime() > now.getTime() + 60_000) {
        console.info("[outbox] crm.reminder.not_due_yet", {
          id: event.id,
          taskId: row.id,
          dueAt: row.dueAt.toISOString(),
          nextAttemptAt: row.dueAt.toISOString(),
        });
        return { status: "retry", nextAttemptAt: row.dueAt };
      }

      const phoneMap = await getTeamMemberPhoneMap(db);
      const recipient = row.assignedTo
        ? (phoneMap[row.assignedTo] ?? null)
        : null;
      if (!recipient) {
        console.warn("[outbox] crm.reminder.missing_recipient", {
          id: event.id,
          taskId: row.id,
          assignedTo: row.assignedTo ?? null,
          phoneMapCount: Object.keys(phoneMap).length,
        });
        await recordProviderFailureSafe("sms", "missing_recipient");
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "crm.reminder.failed",
          entityType: "crm_task",
          entityId: row.id,
          meta: {
            detail: "missing_recipient",
            assignedTo: row.assignedTo ?? null,
          },
        });
        return { status: "processed", error: "missing_recipient" };
      }

      const business = await getBusinessHoursPolicy(db);
      const contactName =
        `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact";
      const contactPhone = row.phoneE164 ?? row.phone ?? null;
      const dueLabel = formatReminderDueAt(row.dueAt, business.timezone);
      const details = notes.trim().length > 0 ? `\n${notes.trim()}` : "";
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
        dueAt: row.dueAt.toISOString(),
      });

      const result = await sendSmsMessage(recipient, message);
      if (result.ok) {
        await recordProviderSuccessSafe("sms");
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "crm.reminder.sent",
          entityType: "crm_task",
          entityId: row.id,
          meta: {
            recipient,
            contactId: row.contactId,
            provider: result.provider ?? null,
          },
        });
        return { status: "processed" };
      }

      const detail = result.detail ?? "reminder_send_failed";
      const retryable = isRetryableSendFailure(detail);
      console.warn("[outbox] crm.reminder.send_failed", {
        id: event.id,
        taskId: row.id,
        recipient,
        detail,
      });

      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "crm.reminder.failed",
        entityType: "crm_task",
        entityId: row.id,
        meta: {
          recipient,
          contactId: row.contactId,
          provider: result.provider ?? null,
          detail,
        },
      });

      if (retryable) {
        return { status: "retry", error: detail };
      }

      await recordProviderFailureSafe("sms", detail);
      return { status: "processed", error: detail };
    }

    case "meta.lead_event": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId =
        typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      if (!leadId) {
        console.warn("[outbox] meta.lead_event.missing_lead", { id: event.id });
        return { status: "skipped" };
      }

      const datasetId = process.env["META_DATASET_ID"];
      const accessToken = process.env["META_CONVERSIONS_TOKEN"];
      if (!datasetId || !accessToken) {
        console.warn("[outbox] meta.lead_event.missing_config", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const leadEventSource =
        typeof process.env["META_LEAD_EVENT_SOURCE"] === "string" &&
        process.env["META_LEAD_EVENT_SOURCE"].trim().length > 0
          ? process.env["META_LEAD_EVENT_SOURCE"].trim()
          : "StonegateOS";
      const eventName =
        typeof payload?.["eventName"] === "string"
          ? payload["eventName"]
          : "Lead";

      const db = getDb();
      const [row] = await db
        .select({
          leadId: leads.id,
          createdAt: leads.createdAt,
          formPayload: leads.formPayload,
          contactEmail: contacts.email,
          contactPhone: contacts.phone,
          contactPhoneE164: contacts.phoneE164,
        })
        .from(leads)
        .leftJoin(contacts, eq(leads.contactId, contacts.id))
        .where(eq(leads.id, leadId))
        .limit(1);

      if (!row) {
        console.warn("[outbox] meta.lead_event.not_found", {
          id: event.id,
          leadId,
        });
        return { status: "skipped" };
      }

      const formPayload = isRecord(row.formPayload) ? row.formPayload : null;
      const leadgenId =
        typeof formPayload?.["leadgenId"] === "string"
          ? formPayload["leadgenId"]
          : null;
      if (!leadgenId) {
        console.warn("[outbox] meta.lead_event.missing_leadgen", {
          id: event.id,
          leadId,
        });
        return { status: "skipped" };
      }

      let eventTime = Math.floor(
        (row.createdAt ?? new Date()).getTime() / 1000,
      );
      const createdTimeRaw =
        typeof formPayload?.["createdTime"] === "string"
          ? formPayload["createdTime"]
          : null;
      if (createdTimeRaw) {
        const parsed = new Date(createdTimeRaw);
        if (!Number.isNaN(parsed.getTime())) {
          eventTime = Math.floor(parsed.getTime() / 1000);
        }
      }

      const userData: Record<string, unknown> = {
        lead_id: leadgenId,
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
              lead_event_source: leadEventSource,
            },
            event_name: eventName,
            event_id: event.id,
            event_time: eventTime,
            user_data: userData,
          },
        ],
      };

      const metaEventsUrl = new URL(
        resolveMetaGraphApiEndpoint([datasetId, "events"], process.env),
      );
      metaEventsUrl.searchParams.set("access_token", accessToken);
      const response = await fetch(metaEventsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadBody),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status >= 500 || response.status === 429;
        const detail = `meta_lead_event_failed:${response.status}`;
        console.warn("[outbox] meta.lead_event.failed", {
          id: event.id,
          status: response.status,
        });
        return retryable
          ? { status: "retry", error: detail }
          : { status: "processed", error: detail };
      }

      const responseBody = (await response.json().catch(() => null)) as {
        events_received?: unknown;
      } | null;
      if (
        !responseBody ||
        typeof responseBody.events_received !== "number" ||
        responseBody.events_received < 1
      ) {
        console.warn("[outbox] meta.lead_event.invalid_response", {
          id: event.id,
          status: response.status,
        });
        return {
          status: "retry",
          error: "meta_lead_event_invalid_response",
        };
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
      const sinceRaw =
        typeof payload?.["since"] === "string" ? payload["since"] : null;
      const untilRaw =
        typeof payload?.["until"] === "string" ? payload["until"] : null;

      const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
      const isIsoDateString = (value: string): boolean =>
        /^\d{4}-\d{2}-\d{2}$/.test(value);

      let since = sinceRaw && isIsoDateString(sinceRaw) ? sinceRaw : null;
      let until = untilRaw && isIsoDateString(untilRaw) ? untilRaw : null;

      if (!since || !until || since > until) {
        const windowDays =
          Number.isFinite(days) && days > 0
            ? Math.min(Math.floor(days), 90)
            : 14;
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
        console.info("[outbox] meta.ads_insights.sync.ok", {
          id: event.id,
          since,
          until,
          ...result,
        });
        return {
          status: "processed",
        };
      } catch (error) {
        const detail =
          error instanceof MetaGraphApiError
            ? `meta_ads_insights_failed:${error.status}`
            : "meta_ads_insights_error";

        await recordProviderFailureSafe("meta_ads", detail);

        const retryable =
          error instanceof MetaGraphApiError
            ? error.status === 429 || error.status >= 500
            : true;

        return retryable
          ? { status: "retry", error: detail }
          : { status: "processed", error: detail };
      }
    }

    case "google.ads_insights.sync": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const daysRaw = payload?.["days"];
      const days =
        typeof daysRaw === "number"
          ? daysRaw
          : typeof daysRaw === "string"
            ? Number(daysRaw)
            : NaN;
      const sinceRaw =
        typeof payload?.["since"] === "string" ? payload["since"] : null;
      const untilRaw =
        typeof payload?.["until"] === "string" ? payload["until"] : null;

      const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
      const isIsoDateString = (value: string): boolean =>
        /^\d{4}-\d{2}-\d{2}$/.test(value);

      let since = sinceRaw && isIsoDateString(sinceRaw) ? sinceRaw : null;
      let until = untilRaw && isIsoDateString(untilRaw) ? untilRaw : null;

      if (!since || !until || since > until) {
        const windowDays =
          Number.isFinite(days) && days > 0
            ? Math.min(Math.floor(days), 30)
            : 14;
        const now = new Date();
        const end = isoDate(now);
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - (windowDays - 1));
        const start = isoDate(startDate);
        since = start;
        until = end;
      }

      try {
        const result = await syncGoogleAdsInsightsDaily({ since, until });
        await recordProviderSuccessSafe("google_ads");
        console.info("[outbox] google.ads_insights.sync.ok", {
          id: event.id,
          since,
          until,
          ...result,
        });
        return { status: "processed" };
      } catch (error) {
        const detail =
          error instanceof GoogleAdsApiError
            ? `google_ads_failed:${error.status}:${error.failureCode}`
            : `google_ads_error:${String(error)}`;

        await recordProviderFailureSafe("google_ads", detail);

        if (isGoogleAdsInvalidResponseFailure(error)) {
          return {
            status: "quarantined",
            error: detail,
            quarantineReason: "google_ads_invalid_response",
          };
        }

        const retryable =
          error instanceof GoogleAdsApiError
            ? error.status === 429 || error.status >= 500
            : true;

        return retryable
          ? {
              status: "retry",
              error: detail,
              maxAttempts: GOOGLE_ADS_SYNC_MAX_ATTEMPTS,
              quarantineReason: "google_ads_retry_budget_exhausted",
            }
          : { status: "processed", error: detail };
      }
    }

    case "google.ads_analyst.run": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const rangeDaysRaw = payload?.["rangeDays"];
      const rangeDays =
        typeof rangeDaysRaw === "number"
          ? rangeDaysRaw
          : typeof rangeDaysRaw === "string"
            ? Number(rangeDaysRaw)
            : NaN;

      const sinceRaw =
        typeof payload?.["since"] === "string" ? payload["since"] : null;
      const untilRaw =
        typeof payload?.["until"] === "string" ? payload["until"] : null;
      const createdBy =
        typeof payload?.["createdBy"] === "string"
          ? payload["createdBy"]
          : null;
      const invokedBy = payload?.["invokedBy"] === "admin" ? "admin" : "worker";

      try {
        const result = await runGoogleAdsAnalystReport({
          rangeDays: Number.isFinite(rangeDays)
            ? Math.min(Math.max(Math.floor(rangeDays), 1), 30)
            : undefined,
          since: sinceRaw ?? undefined,
          until: untilRaw ?? undefined,
          invokedBy,
          createdBy,
        });

        if (!result.ok) {
          const detail = `google_ads_analyst_failed:${result.error}${result.detail ? `:${result.detail}` : ""}`;
          await recordProviderFailureSafe("google_ads_analyst", detail);
          return { status: "processed", error: detail };
        }

        await recordProviderSuccessSafe("google_ads_analyst");
        console.info("[outbox] google.ads_analyst.run.ok", {
          id: event.id,
          reportId: result.reportId,
        });
        return { status: "processed" };
      } catch (error) {
        const detail = `google_ads_analyst_error:${String(error)}`;
        await recordProviderFailureSafe("google_ads_analyst", detail);
        return { status: "retry", error: detail };
      }
    }

    case "estimate.reminder": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const appointmentId =
        typeof payload?.["appointmentId"] === "string"
          ? payload["appointmentId"]
          : null;
      const rawWindow = payload?.["windowMinutes"];
      const windowMinutes =
        typeof rawWindow === "number"
          ? rawWindow
          : typeof rawWindow === "string"
            ? Number(rawWindow)
            : NaN;

      if (!appointmentId || !Number.isFinite(windowMinutes)) {
        console.warn("[outbox] estimate.reminder.missing_data", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const confirmationPolicy = await getConfirmationLoopPolicy();
      if (
        !confirmationPolicy.enabled ||
        !confirmationPolicy.windowsMinutes.includes(windowMinutes)
      ) {
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

      await sendEstimateReminder(notification, windowMinutes, event.id);
      return { status: "processed" };
    }

    case "followup.schedule": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId =
        typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const contactId =
        typeof payload?.["contactId"] === "string"
          ? payload["contactId"]
          : null;

      if (!leadId || !contactId) {
        console.warn("[outbox] followup.schedule.missing_data", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      await scheduleLeadFollowups(leadId, contactId);
      return { status: "processed" };
    }

    case "followup.send": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const leadId =
        typeof payload?.["leadId"] === "string" ? payload["leadId"] : null;
      const channelRaw =
        typeof payload?.["channel"] === "string" ? payload["channel"] : null;
      const step =
        typeof payload?.["step"] === "number"
          ? payload["step"]
          : Number(payload?.["step"]);
      const anchorAtRaw =
        typeof payload?.["anchorAt"] === "string" ? payload["anchorAt"] : null;

      if (
        !leadId ||
        (channelRaw !== "sms" && channelRaw !== "email") ||
        !Number.isFinite(step)
      ) {
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
          propertyId: leads.propertyId,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);

      if (!leadRow) {
        return { status: "skipped" };
      }

      if (leadRow.status === "scheduled") {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const [appointment] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, leadId),
            ne(appointments.status, "canceled"),
          ),
        )
        .limit(1);

      if (appointment?.id) {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const state = await getLeadAutomationState(db, leadId, channel);
      if (
        state.paused ||
        state.dnc ||
        state.humanTakeover ||
        state.followupState === "stopped"
      ) {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const mode = await getAutomationMode(db, channel);
      if (mode === "draft") {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const [contact] = await db
        .select({
          email: contacts.email,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
        })
        .from(contacts)
        .where(
          and(eq(contacts.id, leadRow.contactId), isNull(contacts.deletedAt)),
        )
        .limit(1);

      const toAddress = contact
        ? getContactChannelAddress(contact, channel)
        : null;
      if (!toAddress) {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const threadId = await ensureThreadForLead(db, {
        leadId,
        contactId: leadRow.contactId,
        propertyId: leadRow.propertyId ?? null,
        channel,
      });
      if (!threadId) {
        await clearLeadFollowups(leadId, { excludeOutboxEventId: event.id });
        return { status: "processed" };
      }

      const templates = await getTemplatesPolicy(db);
      const body =
        resolveTemplateForChannel(templates.follow_up, {
          replyChannel: channel,
        }) ??
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
          leadId,
        },
      });

      if (!messageId) {
        return { status: "retry", error: "followup_message_failed" };
      }

      const anchorAt = anchorAtRaw ? new Date(anchorAtRaw) : new Date();
      const anchor = Number.isNaN(anchorAt.getTime()) ? new Date() : anchorAt;
      const nextStep = step + 1;
      const nextStepMinutes =
        nextStep < steps.length ? steps[nextStep] : undefined;
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
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leadAutomationStates.leadId, leadId),
            eq(leadAutomationStates.channel, channel),
          ),
        );

      return { status: "processed" };
    }

    case "call.recording.process": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const callSid =
        typeof payload?.["callSid"] === "string"
          ? payload["callSid"].trim()
          : "";
      if (!callSid) {
        console.warn("[outbox] call.recording.process.missing_call_sid", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      const db = getDb();
      const lease = await claimRecordingProcessingLease({
        db,
        outboxEventId: event.id,
        callSid,
      });
      if (lease.kind === "deferred") {
        return {
          status: "retry",
          error: "recording_processing_lease_active",
          nextAttemptAt: lease.retryAt,
          skipFinalization: true,
        };
      }
      if (lease.kind === "already_terminal") {
        return { status: "processed", skipFinalization: true };
      }
      if (lease.kind === "call_missing") {
        return {
          status: "retry",
          error: "call_record_missing",
          nextAttemptAt: new Date(Date.now() + 60_000),
        };
      }

      const { call, leaseToken } = lease;
      const deferLease = async (
        error: string,
        nextAttemptAt = new Date(Date.now() + 60_000),
      ): Promise<OutboxOutcome> => {
        const result = await deferRecordingProcessingLease({
          db,
          outboxEventId: event.id,
          leaseToken,
          error,
          nextAttemptAt,
        });
        return {
          status: result === "deferred" ? "retry" : "skipped",
          error,
          nextAttemptAt,
          skipFinalization: true,
        };
      };

      try {
        let recordingList = await listTwilioRecordingsForCall(callSid);
        if (!recordingList.ok) {
          return deferLease(`recording_list_${recordingList.code}`);
        }
        if (
          recordingList.empty &&
          typeof call.parentCallSid === "string" &&
          call.parentCallSid.trim().length > 0
        ) {
          recordingList = await listTwilioRecordingsForCall(
            call.parentCallSid.trim(),
          );
          if (!recordingList.ok) {
            return deferLease(`recording_parent_list_${recordingList.code}`);
          }
        }

        if (recordingList.empty) {
          const poll = await recordVerifiedEmptyRecordingPoll({
            db,
            outboxEventId: event.id,
            callRecordId: call.id,
            leaseToken,
          });
          if (poll.kind === "retry") {
            return {
              status: "retry",
              error: "recordings_not_ready",
              skipFinalization: true,
            };
          }
          return {
            status: poll.kind === "lease_lost" ? "skipped" : "processed",
            skipFinalization: true,
          };
        }

        const best = recordingList.recordings
          .slice()
          .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))[0];

        if (!best) {
          return deferLease("recording_list_inconsistent");
        }

        const audio = await downloadTwilioRecordingAudio(best.sid);
        if (!audio.ok) {
          return deferLease(
            `recording_download_${audio.code}`,
            new Date(
              Date.now() + (audio.retryable ? 60_000 : 24 * 60 * 60_000),
            ),
          );
        }

        const transcript = await transcribeAudio(audio.buffer, {
          contentType: audio.contentType,
          filename: audio.filename,
        });
        if (!transcript) {
          const hasKey =
            typeof process.env["OPENAI_API_KEY"] === "string" &&
            process.env["OPENAI_API_KEY"].trim().length > 0;
          if (!hasKey) {
            const recordingCreatedAt = best.dateCreated
              ? new Date(best.dateCreated)
              : null;
            const persisted = await persistSkippedRecordingProcessing({
              db,
              outboxEventId: event.id,
              leaseToken,
              callRecordId: call.id,
              recording: {
                callSid,
                recordingSid: best.sid,
                durationSec: best.durationSec,
                createdAt:
                  recordingCreatedAt &&
                  !Number.isNaN(recordingCreatedAt.getTime())
                    ? recordingCreatedAt
                    : null,
              },
              reason: "transcription_not_configured",
            });
            return {
              status: persisted === "lease_lost" ? "skipped" : "processed",
              skipFinalization: true,
            };
          }
          return deferLease("transcription_failed");
        }

        const companyProfile = await getCompanyProfilePolicy(db);
        let agentName = "Sales";
        if (call.assignedTo) {
          const [member] = await db
            .select({ name: teamMembers.name })
            .from(teamMembers)
            .where(eq(teamMembers.id, call.assignedTo))
            .limit(1);
          if (
            typeof member?.name === "string" &&
            member.name.trim().length > 0
          ) {
            agentName = member.name.trim();
          }
        } else {
          const autopilot = await getSalesAutopilotPolicy(db);
          if (
            typeof autopilot.agentDisplayName === "string" &&
            autopilot.agentDisplayName.trim().length > 0
          ) {
            agentName = autopilot.agentDisplayName.trim();
          }
        }

        const analysis = await analyzeCallTranscript({
          transcript,
          agentName,
          businessName: companyProfile.businessName,
        });
        if (!analysis) {
          return deferLease("analysis_failed");
        }

        const now = new Date();
        const deleteAfter = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const recordingCreatedAt = best.dateCreated
          ? new Date(best.dateCreated)
          : null;
        const [existingInbound, existingOutbound] = await Promise.all([
          db
            .select({ id: callCoaching.id })
            .from(callCoaching)
            .where(
              and(
                eq(callCoaching.callRecordId, call.id),
                eq(callCoaching.rubric, "inbound"),
                eq(callCoaching.version, 1),
              ),
            )
            .limit(1),
          db
            .select({ id: callCoaching.id })
            .from(callCoaching)
            .where(
              and(
                eq(callCoaching.callRecordId, call.id),
                eq(callCoaching.rubric, "outbound"),
                eq(callCoaching.version, 1),
              ),
            )
            .limit(1),
        ]);
        // All provider/model work completes before the single local transaction.
        const [inboundCoaching, outboundCoaching, businessHours] =
          await Promise.all([
            existingInbound[0]?.id
              ? Promise.resolve(null)
              : scoreCallTranscript({
                  transcript,
                  agentName,
                  businessName: companyProfile.businessName,
                  rubric: "inbound",
                }),
            existingOutbound[0]?.id
              ? Promise.resolve(null)
              : scoreCallTranscript({
                  transcript,
                  agentName,
                  businessName: companyProfile.businessName,
                  rubric: "outbound",
                }),
            getBusinessHoursPolicy(db),
          ]);
        const when = DateTime.fromJSDate(now)
          .setZone(businessHours.timezone)
          .toFormat("LLL d, yyyy h:mm a");

        const persisted = await persistAnalyzedRecording({
          db,
          outboxEventId: event.id,
          leaseToken,
          callRecordId: call.id,
          expectedContactId: call.contactId,
          recording: {
            callSid,
            recordingSid: best.sid,
            durationSec: best.durationSec,
            createdAt:
              recordingCreatedAt && !Number.isNaN(recordingCreatedAt.getTime())
                ? recordingCreatedAt
                : null,
          },
          transcript,
          analysis,
          noteTimestampLabel: when,
          inboundCoaching,
          outboundCoaching,
          deleteAfter,
          now,
        });

        return {
          status: persisted === "lease_lost" ? "skipped" : "processed",
          skipFinalization: true,
        };
      } catch (error) {
        console.warn("[outbox] call.recording.process.failed", {
          eventId: event.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return deferLease("recording_processing_failed");
      }
    }

    case "call.recording.delete": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const callSid =
        typeof payload?.["callSid"] === "string"
          ? payload["callSid"].trim()
          : "";
      const recordingSid =
        typeof payload?.["recordingSid"] === "string"
          ? payload["recordingSid"].trim()
          : "";
      if (!callSid || !recordingSid) {
        console.warn("[outbox] call.recording.delete.missing_payload", {
          id: event.id,
        });
        await quarantineRecordingDeleteEvent({
          db: getDb(),
          outboxEventId: event.id,
          reason: "recording_delete_payload_invalid",
        });
        return { status: "skipped", skipFinalization: true };
      }

      const db = getDb();
      const prepared = await prepareRecordingDelete({
        db,
        outboxEventId: event.id,
        callSid,
        recordingSid,
      });
      if (prepared.kind === "quarantined") {
        return { status: "skipped", skipFinalization: true };
      }
      if (prepared.kind === "already_terminal") {
        return { status: "processed" };
      }

      const now = new Date();
      if (
        prepared.target.deleteAfter instanceof Date &&
        prepared.target.deleteAfter.getTime() > now.getTime()
      ) {
        return {
          status: "retry",
          error: "not_due_yet",
          nextAttemptAt: prepared.target.deleteAfter,
        };
      }

      const deletion = await deleteTwilioRecording(
        prepared.target.recordingSid,
      );
      if (!deletion.ok) {
        return {
          status: "retry",
          error: `recording_delete_${deletion.code}`,
          nextAttemptAt: new Date(
            now.getTime() +
              (deletion.retryable ? 60 * 60_000 : 24 * 60 * 60_000),
          ),
        };
      }

      const finalized = await finalizeRecordingDelete({
        db,
        outboxEventId: event.id,
        target: prepared.target,
        alreadyAbsent: deletion.alreadyAbsent,
        now,
      });
      if (finalized === "quarantined") {
        return { status: "skipped", skipFinalization: true };
      }
      return { status: "processed" };
    }

    case "message.received": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId =
        typeof payload?.["messageId"] === "string"
          ? payload["messageId"]
          : null;
      if (!messageId) {
        console.warn("[outbox] message.received.missing_id", { id: event.id });
        return { status: "skipped" };
      }

      try {
        await maybeNotifyAssigneeForInboundSmsMessage({
          db: getDb(),
          messageId,
        });
      } catch (error) {
        console.warn("[outbox] inbox.alert.failed", {
          messageId,
          error: String(error),
        });
      }

      await handleInboundAutoReply(messageId);
      const autopilotOutcome = await handleInboundSalesAutopilot(messageId);
      if (autopilotOutcome.status === "retry") {
        const now = new Date();
        await getDb()
          .insert(outboxEvents)
          .values({
            type: "sales.autopilot.draft",
            payload: { messageId },
            nextAttemptAt:
              autopilotOutcome.nextAttemptAt ??
              new Date(now.getTime() + 60_000),
            createdAt: now,
          });
        return { status: "processed" };
      }

      await getDb().insert(outboxEvents).values({
        type: "facebook.sales.evaluate",
        payload: { messageId },
        createdAt: new Date(),
      });
      return { status: "processed" };
    }

    case "facebook.sales.evaluate": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId =
        typeof payload?.["messageId"] === "string"
          ? payload["messageId"]
          : null;
      if (!messageId) {
        console.warn("[outbox] facebook.sales.evaluate.missing_id", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      return await handleFacebookSalesEvaluate(messageId);
    }

    case "facebook.sales.action.proposed":
    case "facebook.sales.action.execute":
    case "facebook.sales.human_review":
    case "facebook.sales.shadow_decision":
      return { status: "processed" };

    case "sales.autopilot.draft": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId =
        typeof payload?.["messageId"] === "string"
          ? payload["messageId"]
          : null;
      if (!messageId) {
        console.warn("[outbox] sales.autopilot.draft.missing_id", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      return await handleInboundSalesAutopilot(messageId);
    }

    case "sales.autopilot.autosend": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const draftMessageId =
        typeof payload?.["draftMessageId"] === "string"
          ? payload["draftMessageId"]
          : null;
      const inboundMessageId =
        typeof payload?.["inboundMessageId"] === "string"
          ? payload["inboundMessageId"]
          : null;
      if (!draftMessageId) {
        console.warn("[outbox] sales.autopilot.autosend.missing_id", {
          id: event.id,
        });
        return { status: "skipped" };
      }

      return await handleSalesAutopilotAutosend({
        draftMessageId,
        inboundMessageId,
      });
    }

    case "message.send": {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId =
        typeof payload?.["messageId"] === "string"
          ? payload["messageId"]
          : null;
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
          mediaUrls: conversationMessages.mediaUrls,
          toAddress: conversationMessages.toAddress,
          metadata: conversationMessages.metadata,
          deliveryStatus: conversationMessages.deliveryStatus,
          sentAt: conversationMessages.sentAt,
          contactId: conversationThreads.contactId,
          contactDeletedAt: contacts.deletedAt,
          contactPhone: contacts.phone,
          contactPhoneE164: contacts.phoneE164,
          contactEmail: contacts.email,
        })
        .from(conversationMessages)
        .leftJoin(
          conversationThreads,
          eq(conversationMessages.threadId, conversationThreads.id),
        )
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .where(eq(conversationMessages.id, messageId))
        .limit(1);

      const message = rows[0];
      if (!message) {
        console.warn("[outbox] message.send.not_found", { messageId });
        return { status: "skipped" };
      }

      // Defense in depth: processOutboxBatch quarantines the event before the
      // handler, but this local check guarantees no typing indicator or send
      // can occur if the handler is ever invoked through another code path.
      if (message.contactId && message.contactDeletedAt) {
        return { status: "skipped", error: "contact_soft_deleted" };
      }

      if (
        message.deliveryStatus === "sent" ||
        message.deliveryStatus === "delivered"
      ) {
        return { status: "processed" };
      }

      const channel = message.channel ?? "sms";
      const subject = message.subject ?? "Stonegate message";
      const body = message.body ?? "";
      const mediaUrls = Array.isArray(message.mediaUrls)
        ? message.mediaUrls.filter(
            (url): url is string =>
              typeof url === "string" && url.trim().length > 0,
          )
        : [];
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
        const resolvedMetadata = await resolveDmSendMetadata(
          db,
          message.threadId,
          metadata,
        );
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
        metadata?.["automation"] === true ||
        metadata?.["autoFirstTouch"] === true ||
        metadata?.["salesAutopilot"] === true;
      const allowDncOverride = metadata?.["allowDncOverride"] === true;
      const bypassQuietHours =
        metadata?.["autoReply"] === true ||
        metadata?.["confirmationLoop"] === true ||
        metadata?.["autoFirstTouch"] === true;

      if (isAutomated && !bypassQuietHours) {
        const quietHours = await getQuietHoursPolicy(db);
        const businessHours = await getBusinessHoursPolicy(db);
        const quietUntil = nextQuietHoursEnd(
          now,
          channel,
          quietHours,
          businessHours.timezone,
        );
        if (quietUntil) {
          return {
            status: "retry",
            error: "quiet_hours",
            nextAttemptAt: quietUntil,
          };
        }
      }
      const attempt = (event.attempts ?? 0) + 1;

      const delayFromMeta =
        readMetaNumber(metadata, "humanisticDelayMs") ??
        readMetaNumber(metadata, "autoReplyDelayMs");
      const delayMs =
        channel === "dm"
          ? (delayFromMeta ?? (isAutomated ? randomHumanisticDelayMs() : null))
          : null;
      const typingSentAt =
        typeof metadata?.["dmTypingSentAt"] === "string"
          ? metadata?.["dmTypingSentAt"]
          : null;

      if (channel === "dm" && delayMs && !typingSentAt && toAddress) {
        const typingResult = await sendDmTyping(
          toAddress,
          "typing_on",
          metadata,
        );
        if (!typingResult.ok) {
          console.warn("[outbox] dm.typing_failed", {
            messageId,
            detail: typingResult.detail,
          });
        }

        const updatedMetadata = mergeMetadata(metadata, {
          dmTypingSentAt: now.toISOString(),
          humanisticDelayMs: delayMs,
        });
        await db
          .update(conversationMessages)
          .set({ metadata: updatedMetadata })
          .where(eq(conversationMessages.id, message.id));

        return {
          status: "retry",
          error: "dm_typing_delay",
          nextAttemptAt: new Date(now.getTime() + delayMs),
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
          occurredAt: now,
        });
        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "message.failed",
          entityType: "conversation_message",
          entityId: message.id,
          meta: { channel, reason: "missing_recipient" },
        });
        return { status: "processed" };
      }

      if (
        message.contactId &&
        (channel === "sms" || channel === "email" || channel === "dm")
      ) {
        // Persist the resolved destination before the durable request. The
        // dispatch ledger deliberately stores no raw recipient PII.
        await db
          .update(conversationMessages)
          .set({ toAddress })
          .where(eq(conversationMessages.id, message.id));

        let requested: Awaited<
          ReturnType<typeof ensureMessageDispatchRequested>
        >;
        try {
          requested = await ensureMessageDispatchRequested({
            outboxEventId: event.id,
            messageId: message.id,
            contactId: message.contactId,
            channel: channel as ExternalMessageChannel,
            attemptNumber: attempt,
            allowDncOverride,
            now,
          });
        } catch (error) {
          // Do not advance the outbox attempt when persistence itself is
          // uncertain. A later run must re-read this same durable attempt.
          console.error("[outbox] message.dispatch_request_uncertain", {
            eventId: event.id,
            messageId,
            error: String(error),
          });
          return {
            status: "retry",
            error: "message_dispatch_request_uncertain",
            skipFinalization: true,
          };
        }

        if (requested.kind === "unavailable") {
          return { status: "skipped", skipFinalization: true };
        }
        if (requested.kind === "contact_unavailable") {
          return {
            status: "skipped",
            error: requested.reason,
            skipFinalization: true,
          };
        }

        let claimed: Awaited<ReturnType<typeof claimMessageDispatch>>;
        try {
          claimed = await claimMessageDispatch({
            dispatchId: requested.dispatch.id,
            now: new Date(),
          });
        } catch (error) {
          console.error("[outbox] message.dispatch_claim_uncertain", {
            eventId: event.id,
            messageId,
            dispatchId: requested.dispatch.id,
            error: String(error),
          });
          return {
            status: "retry",
            error: "message_dispatch_claim_uncertain",
            skipFinalization: true,
          };
        }

        if (claimed.kind === "unavailable") {
          return {
            status: "skipped",
            error: "message_dispatch_unavailable",
            skipFinalization: true,
          };
        }
        if (claimed.kind === "in_flight") {
          return {
            status: "retry",
            error: "message_dispatch_in_flight",
            nextAttemptAt: claimed.retryAt,
            skipFinalization: true,
          };
        }
        if (claimed.kind === "settled") {
          return {
            status: claimed.retryable ? "retry" : "processed",
            error: claimed.error,
            skipFinalization: claimed.outboxFinalized,
          };
        }

        let durableResult: Awaited<ReturnType<typeof sendSmsMessage>>;
        try {
          const emailAttachments =
            channel === "email" ? readEmailAttachments(metadata) : undefined;
          const options = {
            idempotencyKey: claimed.providerRequestKey,
            emailAttachments: emailAttachments ?? undefined,
          };
          if (channel === "email" && emailAttachments === null) {
            durableResult = {
              ok: false,
              provider: "smtp",
              providerIdempotencySupported: false,
              deliveryCertainty: "not_sent",
              detail: "email_attachment_invalid",
            };
          } else if (channel === "sms") {
            durableResult = await sendSmsMessage(
              toAddress,
              body,
              mediaUrls,
              options,
            );
          } else if (channel === "email") {
            durableResult = await sendEmailMessage(
              toAddress,
              subject,
              body,
              options,
            );
          } else {
            durableResult = await sendDmMessage(
              toAddress,
              body,
              metadata,
              mediaUrls,
              options,
            );
          }
        } catch {
          // Provider helpers normally return uncertainty rather than throw.
          // This final guard ensures an unexpected transport exception can
          // never enter the automatic retry path.
          durableResult = {
            ok: false,
            provider: channel,
            providerIdempotencySupported: false,
            deliveryCertainty: "uncertain",
            detail: "provider_dispatch_exception",
          };
        }

        const detail = durableResult.detail ?? null;
        const retryable =
          durableResult.deliveryCertainty !== "uncertain" &&
          isRetryableSendFailure(detail) &&
          attempt < MAX_MESSAGE_SEND_ATTEMPTS;
        let finalized: Awaited<ReturnType<typeof finalizeMessageDispatch>>;
        try {
          finalized = await finalizeMessageDispatch({
            dispatchId: claimed.dispatchId,
            result: durableResult,
            retryable,
            now: new Date(),
          });
        } catch (error) {
          // dispatched was committed before the provider call. If result
          // persistence is unavailable, leave that attempt untouched and let
          // its uncertainty deadline force manual reconciliation.
          console.error("[outbox] message.dispatch_finalize_uncertain", {
            eventId: event.id,
            messageId,
            dispatchId: claimed.dispatchId,
            error: String(error),
          });
          return {
            status: "retry",
            error: "message_dispatch_finalize_uncertain",
            skipFinalization: true,
          };
        }

        const providerHealth =
          channel === "sms" || channel === "email" ? channel : null;
        if (providerHealth) {
          if (finalized.state === "succeeded") {
            await recordProviderSuccessSafe(providerHealth);
          } else {
            await recordProviderFailureSafe(providerHealth, finalized.error);
          }
        }

        if (channel === "dm" && typingSentAt && toAddress) {
          const typingOff = await sendDmTyping(
            toAddress,
            "typing_off",
            metadata,
          );
          if (!typingOff.ok) {
            console.warn("[outbox] dm.typing_off_failed", {
              messageId,
              detail: typingOff.detail,
            });
          }
        }

        return {
          status: finalized.retryable ? "retry" : "processed",
          error: finalized.error,
          skipFinalization: finalized.outboxFinalized,
        };
      }

      const legacyProviderRequestKey = buildLegacyOutboxProviderRequestKey({
        outboxEventId: event.id,
        messageId: message.id,
        channel,
        attemptNumber: attempt,
      });
      let result: Awaited<ReturnType<typeof sendSmsMessage>>;
      if (channel === "sms") {
        result = await sendSmsMessage(toAddress, body, mediaUrls);
      } else if (channel === "email") {
        result = await sendEmailMessage(toAddress, subject, body, {
          // Stable Message-ID evidence only; SMTP is not exactly-once.
          idempotencyKey: legacyProviderRequestKey,
        });
      } else if (channel === "dm") {
        result = await sendDmMessage(toAddress, body, metadata, mediaUrls);
      } else {
        result = {
          ok: false,
          provider: "unknown",
          detail: "unsupported_channel",
        };
      }

      const detail = result.detail ?? null;

      if (!result.ok) {
        const retryable = isRetryableSendFailure(detail);
        const canRetry =
          result.deliveryCertainty !== "uncertain" &&
          retryable &&
          attempt < MAX_MESSAGE_SEND_ATTEMPTS;
        const providerHealth =
          channel === "sms" || channel === "email" ? channel : null;

        await db
          .update(conversationMessages)
          .set({
            deliveryStatus: canRetry ? "queued" : "failed",
            provider: result.provider ?? null,
            providerMessageId: result.providerMessageId ?? null,
            toAddress,
          })
          .where(eq(conversationMessages.id, message.id));

        await db.insert(messageDeliveryEvents).values({
          messageId: message.id,
          status: "failed",
          detail,
          provider: result.provider ?? null,
          occurredAt: now,
        });

        await recordAuditEvent({
          actor: { type: "worker", label: "outbox" },
          action: "message.failed",
          entityType: "conversation_message",
          entityId: message.id,
          meta: {
            channel,
            provider: result.provider ?? null,
            detail,
            attempt,
            willRetry: canRetry,
          },
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
          toAddress,
        })
        .where(eq(conversationMessages.id, message.id));

      await db.insert(messageDeliveryEvents).values({
        messageId: message.id,
        status: "sent",
        detail,
        provider: result.provider ?? null,
        occurredAt: now,
      });

      await recordAuditEvent({
        actor: { type: "worker", label: "outbox" },
        action: "message.sent",
        entityType: "conversation_message",
        entityId: message.id,
        meta: {
          channel,
          provider: result.provider ?? null,
          detail,
        },
      });

      if (channel === "dm" && typingSentAt && toAddress) {
        const typingOff = await sendDmTyping(toAddress, "typing_off", metadata);
        if (!typingOff.ok) {
          console.warn("[outbox] dm.typing_off_failed", {
            messageId,
            detail: typingOff.detail,
          });
        }
      }

      if (channel === "sms" || channel === "email") {
        await recordProviderSuccessSafe(channel);
      }

      return { status: "processed" };
    }

    default:
      if (isQuoteEventType(event.type)) {
        return {
          status: "quarantined",
          error: "unknown_quote_event",
          quarantineReason: "unknown_quote_event",
        };
      }
      return { status: "skipped" };
  }
}

export async function processOutboxBatch(
  options: ProcessOutboxBatchOptions = {},
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
        isNull(outboxEvents.quarantinedAt),
        or(
          isNull(outboxEvents.nextAttemptAt),
          lte(outboxEvents.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit);

  const stats: OutboxBatchStats = {
    total: events.length,
    processed: 0,
    skipped: 0,
    errors: 0,
  };

  for (const event of events) {
    const dispatchBlock = getOutboxDispatchBlock(event.type);
    if (dispatchBlock) {
      // Operational containment must not consume the event's retry budget.
      // Leave it durable and periodically recheck the switch without entering
      // any handler that could cross a provider boundary.
      await db
        .update(outboxEvents)
        .set({
          nextAttemptAt: new Date(Date.now() + dispatchBlock.retryAfterMs),
          lastError: dispatchBlock.reason,
        })
        .where(eq(outboxEvents.id, event.id));
      stats.skipped += 1;
      continue;
    }

    let contactScope: OutboxContactScope | null = null;
    // Fail closed before any handler can call a provider. Delete-time
    // quarantine catches already queued rows; this guard catches events
    // inserted later or by a concurrent webhook/worker.
    try {
      contactScope = await resolveContactForOutboxEvent(event);
      if (contactScope?.deletedAt && event.type !== "sales.escalation.call") {
        await quarantineOutboxEventForDeletedContact(
          event,
          contactScope.contactId,
        );
        stats.skipped += 1;
        continue;
      }
    } catch (error) {
      const detail = `contact_dispatch_guard_failed:${String(error)}`;
      stats.errors += 1;
      console.warn("[outbox] contact_dispatch_guard_failed", {
        id: event.id,
        type: event.type,
        error: String(error),
      });
      try {
        await db
          .update(outboxEvents)
          .set(
            planOutboxOutcomeFinalization(
              event,
              { status: "retry", error: detail },
              new Date(),
            ),
          )
          .where(eq(outboxEvents.id, event.id));
      } catch (updateError) {
        console.warn("[outbox] contact_dispatch_guard_retry_failed", {
          id: event.id,
          error: String(updateError),
        });
      }
      continue;
    }

    let outcome: OutboxOutcome = { status: "skipped" };
    let finalizedWithinContactLock = false;
    try {
      if (
        contactScope &&
        event.type !== "message.send" &&
        !CONTACT_MESSAGE_ENQUEUE_EVENT_TYPES.has(event.type)
      ) {
        const guarded = await handleContactScopedOutboxEvent(
          event,
          contactScope.contactId,
        );
        if (guarded.kind === "deleted") {
          try {
            await quarantineOutboxEventForDeletedContact(
              event,
              contactScope.contactId,
            );
          } catch (error) {
            throw new ContactDispatchGuardFailure(error);
          }
          stats.skipped += 1;
          continue;
        }
        if (guarded.kind === "unavailable") {
          stats.skipped += 1;
          continue;
        }
        outcome = guarded.outcome;
        finalizedWithinContactLock = true;
      } else {
        outcome = await handleOutboxEvent(event);
      }
    } catch (error) {
      if (error instanceof ContactDispatchGuardFailure) {
        stats.errors += 1;
        console.warn("[outbox] contact_dispatch_guard_failed", {
          id: event.id,
          type: event.type,
          error: error.message,
        });
        try {
          await db
            .update(outboxEvents)
            .set(
              planOutboxOutcomeFinalization(
                event,
                { status: "retry", error: error.message },
                new Date(),
              ),
            )
            .where(eq(outboxEvents.id, event.id));
        } catch (updateError) {
          console.warn("[outbox] contact_dispatch_guard_retry_failed", {
            id: event.id,
            error: String(updateError),
          });
        }
        continue;
      }
      if (error instanceof OutboxFinalizationFailure) {
        stats.errors += 1;
        console.error("[outbox] finalization_reconciliation_required", {
          id: event.id,
          type: event.type,
          error: error.message,
        });
        try {
          if (!contactScope) {
            throw new Error("contact_scope_missing_for_reconciliation");
          }
          const reconciliationState =
            await quarantineOutboxEventForFinalizationReconciliation(
              event,
              contactScope.contactId,
            );
          if (reconciliationState === "already_terminal") {
            console.warn("[outbox] reconciliation_event_already_terminal", {
              id: event.id,
              type: event.type,
            });
          }
        } catch (updateError) {
          console.error("[outbox] reconciliation_marker_failed", {
            id: event.id,
            error: String(updateError),
          });
          // If only the audit write failed, prioritize preventing a duplicate
          // provider effect and emit an explicit operational error. A total
          // persistence outage can still defeat this best-effort fallback;
          // durable pre-dispatch/provider idempotency remains required.
          if (contactScope) {
            try {
              await quarantineOutboxEventForFinalizationReconciliation(
                event,
                contactScope.contactId,
                { writeAudit: false },
              );
              console.error(
                "[outbox] reconciliation_quarantined_without_audit",
                { id: event.id, type: event.type },
              );
            } catch (persistenceError) {
              console.error("[outbox] reconciliation_persistence_unavailable", {
                id: event.id,
                type: event.type,
                error: String(persistenceError),
              });
            }
          }
        }
        continue;
      }
      outcome = outcomeForOutboxHandlerError(event, error);
    }

    if (outcome.status === "processed") {
      stats.processed += 1;
    } else if (
      outcome.status === "skipped" ||
      outcome.status === "quarantined"
    ) {
      stats.skipped += 1;
    } else {
      stats.errors += 1;
    }

    if (finalizedWithinContactLock) continue;
    if (outcome.skipFinalization) continue;

    try {
      await finalizeOutboxEvent(db, event, outcome);
    } catch (error) {
      console.warn("[outbox] mark_processed_failed", {
        id: event.id,
        error: String(error),
      });
    }
  }

  return stats;
}
