import { and, eq } from "drizzle-orm";
import { auditLogs, getDb, partnerNotificationPreferences } from "@/db";

export const PARTNER_NOTIFICATION_EVENT_KEYS = [
  "booking_created",
  "booking_changed",
  "crew_en_route",
  "job_completed",
  "invoice_issued",
  "payment_received",
  "message_received",
  "proof_ready",
  "approval_requested",
  "account_access",
] as const;
export type PartnerNotificationEventKey =
  (typeof PARTNER_NOTIFICATION_EVENT_KEYS)[number];

const EVENT_SET = new Set<string>(PARTNER_NOTIFICATION_EVENT_KEYS);
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

export type PartnerNotificationPreference = {
  id: string | null;
  eventKey: PartnerNotificationEventKey;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  smsVerifiedOptInAt: Date | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  updatedAt: Date | null;
};

export type PartnerNotificationPreferenceInput = Omit<
  PartnerNotificationPreference,
  "id" | "smsVerifiedOptInAt" | "updatedAt"
>;

function validTimezone(timezone: string): boolean {
  if (timezone.length < 1 || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function parsePartnerNotificationPreference(
  value: unknown,
): PartnerNotificationPreferenceInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const exactKeys = [
    "emailEnabled",
    "eventKey",
    "inAppEnabled",
    "quietHoursEnd",
    "quietHoursStart",
    "smsEnabled",
    "timezone",
  ];
  if (
    Object.keys(record).sort().join("\0") !== exactKeys.sort().join("\0") ||
    typeof record["eventKey"] !== "string" ||
    !EVENT_SET.has(record["eventKey"]) ||
    typeof record["inAppEnabled"] !== "boolean" ||
    typeof record["emailEnabled"] !== "boolean" ||
    typeof record["smsEnabled"] !== "boolean" ||
    typeof record["timezone"] !== "string"
  ) {
    return null;
  }
  const quietHoursStart = record["quietHoursStart"];
  const quietHoursEnd = record["quietHoursEnd"];
  const quietHoursValid =
    (quietHoursStart === null && quietHoursEnd === null) ||
    (typeof quietHoursStart === "string" &&
      typeof quietHoursEnd === "string" &&
      TIME_PATTERN.test(quietHoursStart) &&
      TIME_PATTERN.test(quietHoursEnd));
  const timezone = record["timezone"].trim();
  if (!quietHoursValid || !validTimezone(timezone)) return null;
  return {
    eventKey: record["eventKey"] as PartnerNotificationEventKey,
    inAppEnabled: record["inAppEnabled"],
    emailEnabled: record["emailEnabled"],
    smsEnabled: record["smsEnabled"],
    quietHoursStart,
    quietHoursEnd,
    timezone,
  };
}

export async function listPartnerNotificationPreferences(input: {
  accountId: string;
  membershipId: string;
}): Promise<PartnerNotificationPreference[]> {
  const rows = await getDb()
    .select({
      id: partnerNotificationPreferences.id,
      eventKey: partnerNotificationPreferences.eventKey,
      inAppEnabled: partnerNotificationPreferences.inAppEnabled,
      emailEnabled: partnerNotificationPreferences.emailEnabled,
      smsEnabled: partnerNotificationPreferences.smsEnabled,
      smsVerifiedOptInAt: partnerNotificationPreferences.smsVerifiedOptInAt,
      quietHoursStart: partnerNotificationPreferences.quietHoursStart,
      quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
      timezone: partnerNotificationPreferences.timezone,
      updatedAt: partnerNotificationPreferences.updatedAt,
    })
    .from(partnerNotificationPreferences)
    .where(
      and(
        eq(partnerNotificationPreferences.partnerAccountId, input.accountId),
        eq(partnerNotificationPreferences.membershipId, input.membershipId),
      ),
    );
  const byEvent = new Map(rows.map((row) => [row.eventKey, row]));
  return PARTNER_NOTIFICATION_EVENT_KEYS.map((eventKey) => {
    const row = byEvent.get(eventKey);
    return row
      ? { ...row, eventKey }
      : {
          id: null,
          eventKey,
          inAppEnabled: true,
          emailEnabled: true,
          smsEnabled: false,
          smsVerifiedOptInAt: null,
          quietHoursStart: null,
          quietHoursEnd: null,
          timezone: "America/New_York",
          updatedAt: null,
        };
  });
}

export function partnerNotificationPreferenceRevision(input: {
  preference: PartnerNotificationPreference;
  membershipId: string;
}): string {
  const row = input.preference;
  return JSON.stringify([
    input.membershipId,
    row.id,
    row.eventKey,
    row.inAppEnabled,
    row.emailEnabled,
    row.smsEnabled,
    row.smsVerifiedOptInAt?.toISOString() ?? null,
    row.quietHoursStart,
    row.quietHoursEnd,
    row.timezone,
    row.updatedAt?.toISOString() ?? null,
  ]);
}

export async function savePartnerNotificationPreference(input: {
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  sessionId: string;
  preference: PartnerNotificationPreferenceInput;
  existing: PartnerNotificationPreference;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PartnerNotificationPreference | "sms_opt_in_required"> {
  if (input.preference.smsEnabled && !input.existing.smsVerifiedOptInAt) {
    return "sms_opt_in_required";
  }
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(partnerNotificationPreferences)
      .values({
        partnerAccountId: input.accountId,
        membershipId: input.membershipId,
        eventKey: input.preference.eventKey,
        inAppEnabled: input.preference.inAppEnabled,
        emailEnabled: input.preference.emailEnabled,
        smsEnabled: input.preference.smsEnabled,
        smsVerifiedOptInAt: input.existing.smsVerifiedOptInAt,
        quietHoursStart: input.preference.quietHoursStart,
        quietHoursEnd: input.preference.quietHoursEnd,
        timezone: input.preference.timezone,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          partnerNotificationPreferences.membershipId,
          partnerNotificationPreferences.eventKey,
        ],
        set: {
          inAppEnabled: input.preference.inAppEnabled,
          emailEnabled: input.preference.emailEnabled,
          smsEnabled: input.preference.smsEnabled,
          quietHoursStart: input.preference.quietHoursStart,
          quietHoursEnd: input.preference.quietHoursEnd,
          timezone: input.preference.timezone,
          updatedAt: now,
        },
      })
      .returning({
        id: partnerNotificationPreferences.id,
        eventKey: partnerNotificationPreferences.eventKey,
        inAppEnabled: partnerNotificationPreferences.inAppEnabled,
        emailEnabled: partnerNotificationPreferences.emailEnabled,
        smsEnabled: partnerNotificationPreferences.smsEnabled,
        smsVerifiedOptInAt: partnerNotificationPreferences.smsVerifiedOptInAt,
        quietHoursStart: partnerNotificationPreferences.quietHoursStart,
        quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
        timezone: partnerNotificationPreferences.timezone,
        updatedAt: partnerNotificationPreferences.updatedAt,
      });
    if (!saved) throw new Error("partner_notification_preference_not_saved");
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.partnerUserId,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.notification_preference.updated",
      entityType: "partner_notification_preference",
      entityId: saved.id,
      meta: {
        accountId: input.accountId,
        membershipId: input.membershipId,
        eventKey: saved.eventKey,
      },
      createdAt: now,
    });
    return {
      ...saved,
      eventKey: saved.eventKey as PartnerNotificationEventKey,
    };
  });
}
