import fs from "node:fs";
import path from "node:path";
import {
  nextPartnerNotificationDeliveryAt,
  partnerNotificationCopy,
  samePartnerLocalDate,
} from "@/lib/partner-notification-delivery";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("partner booking notification delivery policy", () => {
  it("uses fixed, bounded, partner-safe copy for every launch event", () => {
    for (const eventType of [
      "booking.created",
      "booking.review_received",
      "booking.rescheduled",
      "booking.reschedule_review_requested",
      "booking.canceled",
      "booking.cancellation_review_requested",
    ] as const) {
      const copy = partnerNotificationCopy(eventType);
      expect(copy.title.length).toBeLessThanOrEqual(120);
      expect(copy.body.length).toBeLessThanOrEqual(500);
      expect(copy.preferenceEventKey).toMatch(/^booking_(created|changed)$/u);
      expect(`${copy.title} ${copy.body}`.toLowerCase()).not.toContain(
        "appointment id",
      );
    }
  });

  it("defers ordinary overnight delivery to the account-local quiet-hours end", () => {
    expect(
      nextPartnerNotificationDeliveryAt({
        now: new Date("2026-09-01T02:00:00.000Z"),
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: "America/New_York",
        bypassQuietHours: false,
      }).toISOString(),
    ).toBe("2026-09-01T11:00:00.000Z");
  });

  it("supports same-day quiet ranges and leaves outside-hours work due now", () => {
    expect(
      nextPartnerNotificationDeliveryAt({
        now: new Date("2026-09-01T16:30:00.000Z"),
        quietHoursStart: "12:00",
        quietHoursEnd: "13:00",
        timezone: "America/New_York",
        bypassQuietHours: false,
      }).toISOString(),
    ).toBe("2026-09-01T17:00:00.000Z");
    expect(
      nextPartnerNotificationDeliveryAt({
        now: new Date("2026-09-01T18:00:00.000Z"),
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: "America/New_York",
        bypassQuietHours: false,
      }).toISOString(),
    ).toBe("2026-09-01T18:00:00.000Z");
  });

  it("allows only an explicitly classified urgent change to bypass quiet hours", () => {
    expect(
      nextPartnerNotificationDeliveryAt({
        now: new Date("2026-09-01T02:00:00.000Z"),
        quietHoursStart: "21:00",
        quietHoursEnd: "07:00",
        timezone: "America/New_York",
        bypassQuietHours: true,
      }).toISOString(),
    ).toBe("2026-09-01T02:00:00.000Z");
    expect(
      samePartnerLocalDate({
        left: new Date("2026-09-01T02:00:00.000Z"),
        right: new Date("2026-09-01T03:30:00.000Z"),
        timezone: "America/New_York",
      }),
    ).toBe(true);
    expect(
      samePartnerLocalDate({
        left: new Date("2026-09-01T02:00:00.000Z"),
        right: new Date("2026-09-01T13:30:00.000Z"),
        timezone: "America/New_York",
      }),
    ).toBe(false);
  });
});

describe("partner notification durable-delivery contracts", () => {
  const delivery = source("src/lib/partner-notification-delivery.ts");
  const scheduling = source("src/lib/partner-portal-v2-scheduling/service.ts");
  const cancellation = source("app/api/portal/v2/jobs/[jobId]/cancel/route.ts");
  const outbox = source("src/lib/outbox-processor.ts");
  const policy = source("src/lib/outbox-dispatch-policy.ts");
  const schema = source("src/db/schema.ts");
  const migration = source(
    "src/db/migrations/0140_partner_notification_delivery_ledger.sql",
  );
  const journal = JSON.parse(
    source("src/db/migrations/meta/_journal.json"),
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("defaults to in-app and email while keeping SMS disabled", () => {
    expect(delivery).toContain("inAppEnabled: true");
    expect(delivery).toContain("emailEnabled: true");
    expect(delivery).toContain("smsEnabled: false");
  });

  it("requires the current verified endpoint and its exact consent snapshot", () => {
    expect(delivery).toContain(
      'eq(partnerNotificationEndpoints.status, "verified")',
    );
    expect(delivery).toContain(
      "isNull(partnerNotificationEndpoints.revokedAt)",
    );
    expect(delivery).toContain(
      "endpoint.id === preference.smsVerifiedEndpointId",
    );
    expect(delivery).toContain(
      "endpoint.destination === preference.smsVerifiedPhoneE164",
    );
    expect(delivery).toContain(
      "exactDate(endpoint.consentAt, preference.smsVerifiedOptInAt)",
    );
    expect(delivery).toContain(
      "endpoint.consentSource === preference.smsOptInSource",
    );
    expect(delivery).toContain(
      "endpoint.consentVersion === preference.smsConsentVersion",
    );
    expect(delivery).not.toContain("partnerUsers.phoneE164");
  });

  it("puts only an opaque delivery ID on the provider-bound outbox", () => {
    expect(delivery).toContain('"partner.notification.dispatch"');
    expect(delivery).toContain("payload: { deliveryId }");
    expect(delivery).toContain("providerRequestKey");
    expect(delivery).toContain(
      "idempotencyKey: prepared.delivery.providerRequestKey",
    );
    expect(policy).toContain('"partner.notification.dispatch"');
    expect(outbox).toContain("case PARTNER_NOTIFICATION_DELIVERY_EVENT");
    expect(outbox).toContain('getTeamOperationKillSwitchForRisk("external")');
  });

  it("fails closed behind the portal feature gate and never retries uncertainty", () => {
    expect(delivery).toContain(
      "arePartnerPortalOutboundNotificationsEnabled(delivery.accountId)",
    );
    expect(delivery).toContain('delivery.state === "dispatching"');
    expect(delivery).toContain('state: "reconciliation_required"');
    expect(delivery).toContain('result.deliveryCertainty === "uncertain"');
    expect(delivery).toMatch(/!accepted\s*&&\s*!uncertain/u);
  });

  it("routes create, review, reschedule, and cancel events through one transaction helper", () => {
    expect(
      scheduling.match(/queuePartnerBookingNotification\(\{/gu),
    ).toHaveLength(4);
    expect(
      cancellation.match(/queuePartnerBookingNotification\(\{/gu),
    ).toHaveLength(2);
    expect(scheduling).not.toContain("tx.insert(partnerNotifications)");
    expect(cancellation).not.toContain("tx.insert(partnerNotifications)");
    for (const eventType of [
      "booking.created",
      "booking.review_received",
      "booking.rescheduled",
      "booking.reschedule_review_requested",
      "booking.canceled",
      "booking.cancellation_review_requested",
    ]) {
      expect(`${scheduling}\n${cancellation}`).toContain(`"${eventType}"`);
    }
  });

  it("persists account-safe channel intent after migration 0139", () => {
    expect(schema).toContain("partnerNotificationDeliveries");
    expect(migration).toContain(
      'CREATE TABLE "partner_notification_deliveries"',
    );
    expect(migration).toContain(
      'REFERENCES "partner_account_memberships"("id", "partner_account_id")',
    );
    expect(migration).toContain(
      'REFERENCES "partner_bookings"("id", "partner_account_id")',
    );
    const prior = journal.entries.find(
      (entry) => entry.tag === "0139_partner_password_mfa_transactions",
    );
    const current = journal.entries.find(
      (entry) => entry.tag === "0140_partner_notification_delivery_ledger",
    );
    expect(prior).toBeDefined();
    expect(current?.idx).toBe((prior?.idx ?? 0) + 1);
  });
});
