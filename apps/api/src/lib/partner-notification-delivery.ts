import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccounts,
  partnerNotificationDeliveries,
  partnerNotificationEndpoints,
  partnerNotificationPreferences,
  partnerNotifications,
  partnerUsers,
  type DatabaseClient,
  type PartnerNotificationDeliveryEventType,
} from "@/db";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import { arePartnerPortalOutboundNotificationsEnabled } from "@/lib/partner-portal-feature-flags";

export const PARTNER_NOTIFICATION_DELIVERY_EVENT =
  "partner.notification.dispatch";
export const PARTNER_NOTIFICATION_MAX_PROVIDER_ATTEMPTS = 3;
export const PARTNER_NOTIFICATION_UNCERTAINTY_WINDOW_MS = 15 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_TIMEZONE = "America/New_York";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TransactionExecutor = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;

export type QueuePartnerBookingNotificationInput = {
  tx: TransactionExecutor;
  accountId: string;
  membershipId: string;
  fallbackMembershipId?: string | null;
  partnerBookingId: string;
  eventType: PartnerNotificationDeliveryEventType;
  /** Stable operation/version evidence. It is hashed before persistence. */
  dedupeKey: string;
  correlationId: string | null;
  occurredAt: Date;
  accountTimezone?: string | null;
  /** The changed service window. Only same-local-day changes may be urgent. */
  serviceAt?: Date | null;
};

export type QueuePartnerBillingDisputeNotificationInput = {
  tx: TransactionExecutor;
  accountId: string;
  membershipId: string;
  billingDisputeRequestId: string;
  eventType: "billing.dispute_requested" | "billing.dispute_resolved";
  /** Stable request/state evidence. It is hashed before persistence. */
  dedupeKey: string;
  correlationId: string | null;
  occurredAt: Date;
  accountTimezone?: string | null;
};

type QueuePartnerNotificationInput = {
  tx: TransactionExecutor;
  accountId: string;
  membershipId: string;
  fallbackMembershipId?: string | null;
  partnerBookingId: string | null;
  subjectId: string;
  actionPath: string;
  eventType: PartnerNotificationDeliveryEventType;
  dedupeKey: string;
  correlationId: string | null;
  occurredAt: Date;
  accountTimezone?: string | null;
  serviceAt?: Date | null;
};

type NotificationCopy = {
  preferenceEventKey: "booking_created" | "booking_changed" | "invoice_issued";
  inAppEventKey: string;
  title: string;
  body: string;
};

const COPY: Record<PartnerNotificationDeliveryEventType, NotificationCopy> = {
  "booking.created": {
    preferenceEventKey: "booking_created",
    inAppEventKey: "job.created",
    title: "Booking confirmed",
    body: "Your two-hour Stonegate arrival window is confirmed.",
  },
  "booking.review_received": {
    preferenceEventKey: "booking_created",
    inAppEventKey: "job.review_received",
    title: "Request received",
    body: "Stonegate received your service request and will review the details before confirming a schedule.",
  },
  "booking.rescheduled": {
    preferenceEventKey: "booking_changed",
    inAppEventKey: "job.rescheduled",
    title: "Job rescheduled",
    body: "Your new two-hour arrival window is confirmed.",
  },
  "booking.reschedule_review_requested": {
    preferenceEventKey: "booking_changed",
    inAppEventKey: "job.reschedule_review_requested",
    title: "Schedule change received",
    body: "The current schedule remains in place while Stonegate reviews your requested window.",
  },
  "booking.canceled": {
    preferenceEventKey: "booking_changed",
    inAppEventKey: "job.canceled",
    title: "Job canceled",
    body: "Your Stonegate service request was canceled.",
  },
  "booking.cancellation_review_requested": {
    preferenceEventKey: "booking_changed",
    inAppEventKey: "job.cancellation_review_requested",
    title: "Cancellation request received",
    body: "The job remains scheduled while Stonegate reviews your cancellation request.",
  },
  "billing.dispute_requested": {
    preferenceEventKey: "invoice_issued",
    inAppEventKey: "billing.dispute_requested",
    title: "Billing request received",
    body: "Stonegate received your billing request. No charge, balance, adjustment, or refund changed.",
  },
  "billing.dispute_resolved": {
    preferenceEventKey: "invoice_issued",
    inAppEventKey: "billing.dispute_resolved",
    title: "Billing request updated",
    body: "Stonegate updated your billing request. Review the private billing history for the outcome.",
  },
};

function validTimezone(value: string | null | undefined): string {
  const candidate = value?.trim() || DEFAULT_TIMEZONE;
  return DateTime.now().setZone(candidate).isValid
    ? candidate
    : DEFAULT_TIMEZONE;
}

function minutes(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function samePartnerLocalDate(input: {
  left: Date;
  right: Date;
  timezone: string;
}): boolean {
  const timezone = validTimezone(input.timezone);
  return (
    DateTime.fromJSDate(input.left, { zone: "utc" })
      .setZone(timezone)
      .toISODate() ===
    DateTime.fromJSDate(input.right, { zone: "utc" })
      .setZone(timezone)
      .toISODate()
  );
}

/** Returns now outside quiet hours, otherwise the next account-local end. */
export function nextPartnerNotificationDeliveryAt(input: {
  now: Date;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  bypassQuietHours: boolean;
}): Date {
  if (
    input.bypassQuietHours ||
    !input.quietHoursStart ||
    !input.quietHoursEnd
  ) {
    return input.now;
  }
  const start = minutes(input.quietHoursStart);
  const end = minutes(input.quietHoursEnd);
  if (start === null || end === null || start === end) return input.now;
  const timezone = validTimezone(input.timezone);
  const localNow = DateTime.fromJSDate(input.now, { zone: "utc" }).setZone(
    timezone,
  );
  const current = localNow.hour * 60 + localNow.minute;
  const overnight = start > end;
  const inQuietHours = overnight
    ? current >= start || current < end
    : current >= start && current < end;
  if (!inQuietHours) return input.now;
  let quietEnd = localNow.set({
    hour: Math.floor(end / 60),
    minute: end % 60,
    second: 0,
    millisecond: 0,
  });
  if (quietEnd.toMillis() <= localNow.toMillis())
    quietEnd = quietEnd.plus({ days: 1 });
  return quietEnd.toUTC().toJSDate();
}

export function partnerNotificationCopy(
  eventType: PartnerNotificationDeliveryEventType,
): NotificationCopy {
  return COPY[eventType];
}

function dedupeHash(
  input: QueuePartnerNotificationInput,
  membershipId: string,
): string {
  return createHash("sha256")
    .update(
      [
        input.accountId,
        membershipId,
        input.subjectId,
        input.eventType,
        input.dedupeKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
}

function eventMayBypassQuietHours(
  eventType: PartnerNotificationDeliveryEventType,
): boolean {
  return (
    eventType !== "booking.created" && eventType !== "booking.review_received"
  );
}

function exactDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function endpointMatchesConsentSnapshot(input: {
  endpoint:
    | {
        id: string;
        destination: string;
        consentAt: Date | null;
        consentSource: string | null;
        consentVersion: string | null;
        verifiedAt: Date | null;
        revokedAt: Date | null;
      }
    | undefined;
  preference: {
    smsVerifiedEndpointId: string | null;
    smsVerifiedPhoneE164: string | null;
    smsVerifiedOptInAt: Date | null;
    smsOptInSource: string | null;
    smsConsentVersion: string | null;
  };
}): boolean {
  const endpoint = input.endpoint;
  const preference = input.preference;
  return Boolean(
    endpoint &&
      endpoint.verifiedAt &&
      !endpoint.revokedAt &&
      endpoint.id === preference.smsVerifiedEndpointId &&
      endpoint.destination === preference.smsVerifiedPhoneE164 &&
      exactDate(endpoint.consentAt, preference.smsVerifiedOptInAt) &&
      endpoint.consentSource === preference.smsOptInSource &&
      endpoint.consentVersion === preference.smsConsentVersion,
  );
}

function boundedCorrelationId(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

function safeEmailDestination(value: string): string | null {
  const normalized = value.trim();
  return normalized.length >= 3 &&
    normalized.length <= 254 &&
    !/\s/u.test(normalized) &&
    normalized.includes("@")
    ? normalized
    : null;
}

export async function queuePartnerBookingNotification(
  input: QueuePartnerBookingNotificationInput,
): Promise<void> {
  return queuePartnerNotification({
    ...input,
    subjectId: input.partnerBookingId,
    actionPath: `/partners/bookings/${input.partnerBookingId}`,
  });
}

export async function queuePartnerBillingDisputeNotification(
  input: QueuePartnerBillingDisputeNotificationInput,
): Promise<void> {
  if (!UUID_PATTERN.test(input.billingDisputeRequestId)) {
    throw new Error("partner_notification_billing_request_id_invalid");
  }
  return queuePartnerNotification({
    tx: input.tx,
    accountId: input.accountId,
    membershipId: input.membershipId,
    partnerBookingId: null,
    subjectId: input.billingDisputeRequestId,
    actionPath: "/partners/billing",
    eventType: input.eventType,
    dedupeKey: input.dedupeKey,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
    accountTimezone: input.accountTimezone,
  });
}

async function queuePartnerNotification(
  input: QueuePartnerNotificationInput,
): Promise<void> {
  const copy = partnerNotificationCopy(input.eventType);
  const actionPath = input.actionPath;
  if (
    !UUID_PATTERN.test(input.subjectId) ||
    (input.partnerBookingId !== null &&
      !UUID_PATTERN.test(input.partnerBookingId)) ||
    (!/^\/partners\/bookings\/[0-9a-f-]{36}$/u.test(actionPath) &&
      actionPath !== "/partners/billing") ||
    actionPath.length > 200
  ) {
    throw new Error("partner_notification_booking_id_invalid");
  }
  const loadRecipient = async (membershipId: string) => {
    const [row] = await input.tx
      .select({
        membershipStatus: partnerAccountMemberships.status,
        partnerUserId: partnerAccountMemberships.partnerUserId,
        userActive: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        email: partnerUsers.email,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerAccountMemberships.partnerAccountId),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, membershipId),
          eq(partnerAccountMemberships.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    return row;
  };
  let recipientMembershipId = input.membershipId;
  let recipient = await loadRecipient(recipientMembershipId);
  if (
    !recipient &&
    input.fallbackMembershipId &&
    input.fallbackMembershipId !== recipientMembershipId
  ) {
    recipientMembershipId = input.fallbackMembershipId;
    recipient = await loadRecipient(recipientMembershipId);
  }
  if (!recipient) throw new Error("partner_notification_membership_missing");

  const [storedPreference] = await input.tx
    .select({
      inAppEnabled: partnerNotificationPreferences.inAppEnabled,
      emailEnabled: partnerNotificationPreferences.emailEnabled,
      smsEnabled: partnerNotificationPreferences.smsEnabled,
      smsVerifiedOptInAt: partnerNotificationPreferences.smsVerifiedOptInAt,
      smsVerifiedPhoneE164: partnerNotificationPreferences.smsVerifiedPhoneE164,
      smsVerifiedEndpointId:
        partnerNotificationPreferences.smsVerifiedEndpointId,
      smsOptInSource: partnerNotificationPreferences.smsOptInSource,
      smsConsentVersion: partnerNotificationPreferences.smsConsentVersion,
      quietHoursStart: partnerNotificationPreferences.quietHoursStart,
      quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
      timezone: partnerNotificationPreferences.timezone,
    })
    .from(partnerNotificationPreferences)
    .where(
      and(
        eq(partnerNotificationPreferences.partnerAccountId, input.accountId),
        eq(partnerNotificationPreferences.membershipId, recipientMembershipId),
        eq(partnerNotificationPreferences.eventKey, copy.preferenceEventKey),
      ),
    )
    .limit(1);
  const preference = storedPreference ?? {
    inAppEnabled: true,
    emailEnabled: true,
    smsEnabled: false,
    smsVerifiedOptInAt: null,
    smsVerifiedPhoneE164: null,
    smsVerifiedEndpointId: null,
    smsOptInSource: null,
    smsConsentVersion: null,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: validTimezone(input.accountTimezone),
  };
  const [endpoint] =
    preference.smsEnabled && preference.smsVerifiedEndpointId
      ? await input.tx
          .select({
            id: partnerNotificationEndpoints.id,
            destination: partnerNotificationEndpoints.normalizedDestination,
            consentAt: partnerNotificationEndpoints.consentAt,
            consentSource: partnerNotificationEndpoints.consentSource,
            consentVersion: partnerNotificationEndpoints.consentVersion,
            verifiedAt: partnerNotificationEndpoints.verifiedAt,
            revokedAt: partnerNotificationEndpoints.revokedAt,
          })
          .from(partnerNotificationEndpoints)
          .where(
            and(
              eq(
                partnerNotificationEndpoints.id,
                preference.smsVerifiedEndpointId,
              ),
              eq(
                partnerNotificationEndpoints.partnerUserId,
                recipient.partnerUserId,
              ),
              eq(partnerNotificationEndpoints.channel, "sms"),
              eq(partnerNotificationEndpoints.status, "verified"),
              isNull(partnerNotificationEndpoints.revokedAt),
            ),
          )
          .limit(1)
      : [];
  const recipientAvailable =
    recipient.membershipStatus === "active" &&
    recipient.userActive &&
    recipient.identityStatus === "active" &&
    recipient.portalAccessEnabled;
  const timezone = validTimezone(preference.timezone || input.accountTimezone);
  const urgentSameDay = Boolean(
    eventMayBypassQuietHours(input.eventType) &&
      input.serviceAt &&
      samePartnerLocalDate({
        left: input.occurredAt,
        right: input.serviceAt,
        timezone,
      }),
  );
  const scheduledFor = nextPartnerNotificationDeliveryAt({
    now: input.occurredAt,
    quietHoursStart: preference.quietHoursStart,
    quietHoursEnd: preference.quietHoursEnd,
    timezone,
    bypassQuietHours: urgentSameDay,
  });
  const hash = dedupeHash(input, recipientMembershipId);
  const correlationId = boundedCorrelationId(input.correlationId);
  const emailDestination = safeEmailDestination(recipient.email);

  for (const channel of ["in_app", "email", "sms"] as const) {
    const enabled =
      recipientAvailable &&
      (channel === "in_app"
        ? preference.inAppEnabled
        : channel === "email"
          ? preference.emailEnabled && emailDestination !== null
          : preference.smsEnabled &&
            endpointMatchesConsentSnapshot({ endpoint, preference }));
    const suppressedDetail = !recipientAvailable
      ? "recipient_unavailable"
      : channel === "sms" && preference.smsEnabled
        ? "verified_consent_snapshot_unavailable"
        : "preference_disabled";
    const deliveryId = randomUUID();
    const [inserted] = await input.tx
      .insert(partnerNotificationDeliveries)
      .values({
        id: deliveryId,
        partnerAccountId: input.accountId,
        membershipId: recipientMembershipId,
        partnerBookingId: input.partnerBookingId,
        eventType: input.eventType,
        preferenceEventKey: copy.preferenceEventKey,
        channel,
        state: channel === "in_app" && enabled ? "accepted" : "suppressed",
        urgency: urgentSameDay ? "urgent_same_day" : "ordinary",
        dedupeKeyHash: hash,
        title: copy.title,
        body: copy.body,
        actionPath,
        endpointId: channel === "sms" && enabled ? endpoint?.id : null,
        scheduledFor,
        detail: enabled
          ? channel === "in_app"
            ? null
            : "preparing"
          : suppressedDetail,
        correlationId,
        acceptedAt: channel === "in_app" && enabled ? input.occurredAt : null,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: partnerNotificationDeliveries.id });
    if (!inserted) continue;

    if (channel === "in_app") {
      if (!enabled) continue;
      const notificationId = randomUUID();
      await input.tx.insert(partnerNotifications).values({
        id: notificationId,
        partnerAccountId: input.accountId,
        membershipId: recipientMembershipId,
        partnerBookingId: input.partnerBookingId,
        eventKey: copy.inAppEventKey,
        title: copy.title,
        body: copy.body,
        actionPath,
        createdAt: input.occurredAt,
      });
      await input.tx
        .update(partnerNotificationDeliveries)
        .set({ partnerNotificationId: notificationId })
        .where(eq(partnerNotificationDeliveries.id, deliveryId));
      continue;
    }
    if (!enabled) continue;

    const outboxEventId = randomUUID();
    const providerRequestKey = `partner-notification:${deliveryId}`;
    await input.tx.insert(outboxEvents).values({
      id: outboxEventId,
      type: PARTNER_NOTIFICATION_DELIVERY_EVENT,
      payload: { deliveryId },
      nextAttemptAt: scheduledFor,
      createdAt: input.occurredAt,
    });
    await input.tx
      .update(partnerNotificationDeliveries)
      .set({
        state: "queued",
        providerRequestKey,
        outboxEventId,
        detail: null,
        updatedAt: input.occurredAt,
      })
      .where(
        and(
          eq(partnerNotificationDeliveries.id, deliveryId),
          eq(partnerNotificationDeliveries.state, "suppressed"),
        ),
      );
  }
}

export type PartnerNotificationDeliveryOutcome =
  | { status: "processed" }
  | { status: "retry"; error: string; nextAttemptAt: Date };

function safeProviderValue(
  value: string | null | undefined,
  maximum = 500,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

async function settleDispatchingAsReconciliation(input: {
  deliveryId: string;
  outboxEventId: string;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(partnerNotificationDeliveries)
      .set({
        state: "reconciliation_required",
        detail: "dispatch_result_not_persisted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(partnerNotificationDeliveries.id, input.deliveryId),
          eq(partnerNotificationDeliveries.outboxEventId, input.outboxEventId),
          eq(partnerNotificationDeliveries.state, "dispatching"),
        ),
      )
      .returning({
        id: partnerNotificationDeliveries.id,
        accountId: partnerNotificationDeliveries.partnerAccountId,
        membershipId: partnerNotificationDeliveries.membershipId,
      });
    if (!row) return;
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorLabel: "partner-notification-outbox",
      authMethod: "service",
      outcome: "attempted",
      surface: "partner_portal_v2",
      action: "partner.notification.delivery_reconciliation_required",
      entityType: "partner_notification_delivery",
      entityId: row.id,
      meta: {
        accountId: row.accountId,
        membershipId: row.membershipId,
        outboxEventId: input.outboxEventId,
        reason: "dispatch_result_not_persisted",
      },
      createdAt: new Date(),
    });
  });
}

export async function processPartnerNotificationDelivery(input: {
  deliveryId: string;
  outboxEventId: string;
}): Promise<PartnerNotificationDeliveryOutcome> {
  if (!UUID_PATTERN.test(input.deliveryId)) return { status: "processed" };
  const db = getDb();
  const attemptId = randomUUID();
  const prepared = await db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({
        id: partnerNotificationDeliveries.id,
        accountId: partnerNotificationDeliveries.partnerAccountId,
        membershipId: partnerNotificationDeliveries.membershipId,
        bookingId: partnerNotificationDeliveries.partnerBookingId,
        eventType: partnerNotificationDeliveries.eventType,
        preferenceEventKey: partnerNotificationDeliveries.preferenceEventKey,
        channel: partnerNotificationDeliveries.channel,
        state: partnerNotificationDeliveries.state,
        urgency: partnerNotificationDeliveries.urgency,
        title: partnerNotificationDeliveries.title,
        body: partnerNotificationDeliveries.body,
        actionPath: partnerNotificationDeliveries.actionPath,
        endpointId: partnerNotificationDeliveries.endpointId,
        providerRequestKey: partnerNotificationDeliveries.providerRequestKey,
        outboxEventId: partnerNotificationDeliveries.outboxEventId,
        scheduledFor: partnerNotificationDeliveries.scheduledFor,
        attemptCount: partnerNotificationDeliveries.attemptCount,
        dispatchStartedAt: partnerNotificationDeliveries.dispatchStartedAt,
        correlationId: partnerNotificationDeliveries.correlationId,
      })
      .from(partnerNotificationDeliveries)
      .where(eq(partnerNotificationDeliveries.id, input.deliveryId))
      .for("update")
      .limit(1);
    if (!delivery || delivery.outboxEventId !== input.outboxEventId) {
      return { kind: "terminal" as const };
    }
    if (delivery.state === "dispatching") {
      const reconcileAt = delivery.dispatchStartedAt
        ? new Date(
            delivery.dispatchStartedAt.getTime() +
              PARTNER_NOTIFICATION_UNCERTAINTY_WINDOW_MS,
          )
        : null;
      if (reconcileAt && reconcileAt > new Date()) {
        return {
          kind: "retry" as const,
          at: reconcileAt,
          error: "partner_notification_dispatch_in_flight",
        };
      }
      return { kind: "reconciliation" as const };
    }
    if (delivery.state !== "queued") return { kind: "terminal" as const };
    const now = new Date();
    if (delivery.scheduledFor > now) {
      return { kind: "retry" as const, at: delivery.scheduledFor };
    }
    if (!arePartnerPortalOutboundNotificationsEnabled(delivery.accountId)) {
      return {
        kind: "retry" as const,
        at: new Date(now.getTime() + 15 * 60_000),
        error: "partner_notification_feature_disabled",
      };
    }
    const [recipient] = await tx
      .select({
        partnerUserId: partnerAccountMemberships.partnerUserId,
        membershipStatus: partnerAccountMemberships.status,
        userActive: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        email: partnerUsers.email,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerAccountMemberships.partnerAccountId),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, delivery.membershipId),
          eq(partnerAccountMemberships.partnerAccountId, delivery.accountId),
        ),
      )
      .limit(1);
    const [preference] = await tx
      .select({
        emailEnabled: partnerNotificationPreferences.emailEnabled,
        smsEnabled: partnerNotificationPreferences.smsEnabled,
        smsVerifiedOptInAt: partnerNotificationPreferences.smsVerifiedOptInAt,
        smsVerifiedPhoneE164:
          partnerNotificationPreferences.smsVerifiedPhoneE164,
        smsVerifiedEndpointId:
          partnerNotificationPreferences.smsVerifiedEndpointId,
        smsOptInSource: partnerNotificationPreferences.smsOptInSource,
        smsConsentVersion: partnerNotificationPreferences.smsConsentVersion,
        quietHoursStart: partnerNotificationPreferences.quietHoursStart,
        quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
        timezone: partnerNotificationPreferences.timezone,
      })
      .from(partnerNotificationPreferences)
      .where(
        and(
          eq(
            partnerNotificationPreferences.partnerAccountId,
            delivery.accountId,
          ),
          eq(
            partnerNotificationPreferences.membershipId,
            delivery.membershipId,
          ),
          eq(
            partnerNotificationPreferences.eventKey,
            delivery.preferenceEventKey,
          ),
        ),
      )
      .limit(1);
    const defaultPreference = {
      emailEnabled: true,
      smsEnabled: false,
      smsVerifiedOptInAt: null,
      smsVerifiedPhoneE164: null,
      smsVerifiedEndpointId: null,
      smsOptInSource: null,
      smsConsentVersion: null,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: DEFAULT_TIMEZONE,
    };
    const currentPreference = preference ?? defaultPreference;
    const [endpoint] =
      delivery.channel === "sms" && delivery.endpointId && recipient
        ? await tx
            .select({
              id: partnerNotificationEndpoints.id,
              destination: partnerNotificationEndpoints.normalizedDestination,
              consentAt: partnerNotificationEndpoints.consentAt,
              consentSource: partnerNotificationEndpoints.consentSource,
              consentVersion: partnerNotificationEndpoints.consentVersion,
              verifiedAt: partnerNotificationEndpoints.verifiedAt,
              revokedAt: partnerNotificationEndpoints.revokedAt,
            })
            .from(partnerNotificationEndpoints)
            .where(
              and(
                eq(partnerNotificationEndpoints.id, delivery.endpointId),
                eq(
                  partnerNotificationEndpoints.partnerUserId,
                  recipient.partnerUserId,
                ),
                eq(partnerNotificationEndpoints.channel, "sms"),
                eq(partnerNotificationEndpoints.status, "verified"),
                isNull(partnerNotificationEndpoints.revokedAt),
              ),
            )
            .limit(1)
        : [];
    const recipientAvailable = Boolean(
      recipient &&
        recipient.membershipStatus === "active" &&
        recipient.userActive &&
        recipient.identityStatus === "active" &&
        recipient.portalAccessEnabled,
    );
    const channelAllowed =
      recipientAvailable &&
      (delivery.channel === "email"
        ? currentPreference.emailEnabled &&
          Boolean(recipient && safeEmailDestination(recipient.email))
        : delivery.channel === "sms" &&
          currentPreference.smsEnabled &&
          delivery.endpointId === currentPreference.smsVerifiedEndpointId &&
          endpointMatchesConsentSnapshot({
            endpoint,
            preference: currentPreference,
          }));
    if (!channelAllowed || !recipient) {
      await tx
        .update(partnerNotificationDeliveries)
        .set({
          state: "suppressed",
          detail: recipientAvailable
            ? "preference_or_verified_endpoint_changed"
            : "recipient_unavailable",
          updatedAt: now,
        })
        .where(eq(partnerNotificationDeliveries.id, delivery.id));
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorId: recipient?.partnerUserId ?? null,
        actorLabel: "partner-notification-outbox",
        authMethod: "service",
        correlationId: delivery.correlationId,
        outcome: "denied",
        surface: "partner_portal_v2",
        action: "partner.notification.delivery_suppressed",
        entityType: "partner_notification_delivery",
        entityId: delivery.id,
        meta: {
          accountId: delivery.accountId,
          membershipId: delivery.membershipId,
          channel: delivery.channel,
          eventType: delivery.eventType,
          reason: recipientAvailable
            ? "preference_or_verified_endpoint_changed"
            : "recipient_unavailable",
        },
        createdAt: now,
      });
      return { kind: "terminal" as const };
    }
    const nextAllowedAt = nextPartnerNotificationDeliveryAt({
      now,
      quietHoursStart: currentPreference.quietHoursStart,
      quietHoursEnd: currentPreference.quietHoursEnd,
      timezone: currentPreference.timezone,
      bypassQuietHours: delivery.urgency === "urgent_same_day",
    });
    if (nextAllowedAt.getTime() > now.getTime()) {
      await tx
        .update(partnerNotificationDeliveries)
        .set({ scheduledFor: nextAllowedAt, updatedAt: now })
        .where(eq(partnerNotificationDeliveries.id, delivery.id));
      return { kind: "retry" as const, at: nextAllowedAt };
    }
    if (!delivery.providerRequestKey) return { kind: "terminal" as const };
    const [claimed] = await tx
      .update(partnerNotificationDeliveries)
      .set({
        state: "dispatching",
        attemptCount: sql`${partnerNotificationDeliveries.attemptCount} + 1`,
        dispatchAttemptId: attemptId,
        dispatchStartedAt: now,
        detail: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationDeliveries.id, delivery.id),
          eq(partnerNotificationDeliveries.state, "queued"),
        ),
      )
      .returning({ attemptCount: partnerNotificationDeliveries.attemptCount });
    if (!claimed) return { kind: "terminal" as const };
    return {
      kind: "dispatch" as const,
      delivery,
      attemptCount: claimed.attemptCount,
      destination:
        delivery.channel === "email"
          ? (safeEmailDestination(recipient.email) ?? "")
          : (endpoint?.destination ?? ""),
    };
  });

  if (prepared.kind === "reconciliation") {
    await settleDispatchingAsReconciliation(input);
    return { status: "processed" };
  }
  if (prepared.kind === "retry") {
    return {
      status: "retry",
      error:
        ("error" in prepared ? prepared.error : null) ??
        "partner_notification_deferred",
      nextAttemptAt: prepared.at,
    };
  }
  if (prepared.kind !== "dispatch") return { status: "processed" };

  let result: Awaited<ReturnType<typeof sendEmailMessage>>;
  try {
    result =
      prepared.delivery.channel === "email"
        ? await sendEmailMessage(
            prepared.destination,
            prepared.delivery.title,
            `${prepared.delivery.body}\n\nSign in to the Stonegate Partner Portal to view the job.`,
            { idempotencyKey: prepared.delivery.providerRequestKey },
          )
        : await sendSmsMessage(
            prepared.destination,
            `${prepared.delivery.body} Sign in to the Stonegate Partner Portal for details.`,
            null,
            { idempotencyKey: prepared.delivery.providerRequestKey },
          );
  } catch {
    result = {
      ok: false,
      provider: prepared.delivery.channel === "email" ? "smtp" : "twilio",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "provider_dispatch_exception",
    };
  }
  const accepted = result.ok && result.deliveryCertainty === "accepted";
  const uncertain = result.deliveryCertainty === "uncertain";
  const retryable =
    !accepted &&
    !uncertain &&
    prepared.attemptCount < PARTNER_NOTIFICATION_MAX_PROVIDER_ATTEMPTS;
  const state = accepted
    ? "accepted"
    : uncertain
      ? "reconciliation_required"
      : retryable
        ? "queued"
        : "failed";
  const now = new Date();
  const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(partnerNotificationDeliveries)
      .set({
        state,
        provider: safeProviderValue(result.provider, 64),
        providerMessageId: safeProviderValue(result.providerMessageId, 255),
        providerIdempotencySupported:
          result.providerIdempotencySupported ?? false,
        deliveryCertainty: result.deliveryCertainty ?? null,
        detail: accepted
          ? null
          : (safeProviderValue(result.detail) ?? "provider_failed"),
        acceptedAt: accepted ? now : null,
        scheduledFor: retryable ? retryAt : prepared.delivery.scheduledFor,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationDeliveries.id, prepared.delivery.id),
          eq(partnerNotificationDeliveries.outboxEventId, input.outboxEventId),
          eq(partnerNotificationDeliveries.dispatchAttemptId, attemptId),
          eq(partnerNotificationDeliveries.state, "dispatching"),
        ),
      )
      .returning({ id: partnerNotificationDeliveries.id });
    if (!updated) throw new Error("partner_notification_result_not_persisted");
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorLabel: "partner-notification-outbox",
      authMethod: "service",
      correlationId: prepared.delivery.correlationId,
      outcome: accepted ? "succeeded" : uncertain ? "attempted" : "failed",
      surface: "partner_portal_v2",
      providerOperationId: safeProviderValue(result.providerMessageId, 255),
      action: accepted
        ? "partner.notification.delivery_accepted"
        : uncertain
          ? "partner.notification.delivery_reconciliation_required"
          : retryable
            ? "partner.notification.delivery_retry_queued"
            : "partner.notification.delivery_failed",
      entityType: "partner_notification_delivery",
      entityId: prepared.delivery.id,
      meta: {
        accountId: prepared.delivery.accountId,
        membershipId: prepared.delivery.membershipId,
        channel: prepared.delivery.channel,
        eventType: prepared.delivery.eventType,
        outboxEventId: input.outboxEventId,
        provider: safeProviderValue(result.provider, 64),
        attemptCount: prepared.attemptCount,
      },
      createdAt: now,
    });
  });
  return retryable
    ? {
        status: "retry",
        error: safeProviderValue(result.detail) ?? "provider_not_sent",
        nextAttemptAt: retryAt,
      }
    : { status: "processed" };
}
