import fs from "node:fs";
import path from "node:path";
import {
  hashPartnerBookingRequest,
  hashPartnerOperationKey,
  normalizePartnerOperationKey,
  STAFF_NOTIFICATION_MAX_ATTEMPTS,
  STAFF_NOTIFICATION_UNCERTAINTY_WINDOW_MS,
} from "@/lib/staff-notification-operations";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("partner booking handoff integrity", () => {
  it("normalizes and scopes durable partner operation keys", () => {
    expect(normalizePartnerOperationKey("  booking:1234567890  ")).toBe(
      "booking:1234567890",
    );
    expect(normalizePartnerOperationKey("short")).toBeNull();
    expect(
      normalizePartnerOperationKey("spaces are not valid keys"),
    ).toBeNull();
    expect(
      hashPartnerOperationKey(
        "11111111-1111-4111-8111-111111111111",
        "booking:1234567890",
      ),
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      hashPartnerOperationKey(
        "11111111-1111-4111-8111-111111111111",
        "booking:1234567890",
      ),
    ).not.toBe(
      hashPartnerOperationKey(
        "22222222-2222-4222-8222-222222222222",
        "booking:1234567890",
      ),
    );
  });

  it("binds booking replay to the complete normalized request", () => {
    const request = {
      propertyId: "11111111-1111-4111-8111-111111111111",
      preferredDate: "2026-08-10",
      timeWindowId: "morning",
      serviceKey: "junk-removal",
      tierKey: "small",
      notes: "Gate code is in the portal.",
    };
    const hash = hashPartnerBookingRequest(request);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashPartnerBookingRequest(request)).toBe(hash);
    expect(
      hashPartnerBookingRequest({ ...request, preferredDate: "2026-08-11" }),
    ).not.toBe(hash);
    expect(
      hashPartnerBookingRequest({
        ...request,
        rescheduleFromAppointmentId: "22222222-2222-4222-8222-222222222222",
        rescheduleFromVersion: 1,
      }),
    ).not.toBe(hash);
    expect(STAFF_NOTIFICATION_MAX_ATTEMPTS).toBe(3);
    expect(STAFF_NOTIFICATION_UNCERTAINTY_WINDOW_MS).toBe(15 * 60_000);
  });

  it("moves a partner booking atomically instead of creating then canceling", () => {
    const route = source("app/api/portal/bookings/route.ts");
    const actions = source("../site/src/app/partners/actions.ts");
    const bookingPage = source("../site/src/app/partners/book/page.tsx");
    expect(route).toContain('"rescheduleFromAppointmentId"');
    expect(route).toContain('request.headers.get("if-match")');
    expect(route).toContain(
      "partner-booking-cancel:${rescheduleFromAppointmentId}",
    );
    expect(route).toContain(
      "excludeAppointmentId: sourceBooking?.appointmentId",
    );
    expect(route).toContain("version: sourceBooking.bookingVersion + 1");
    expect(route).toContain('reason: "partner.booking.rescheduled"');
    expect(route).toContain('"partner.booking.rescheduled"');
    expect(route).toContain("previousResultingVersion: sourceBookingVersion");
    expect(route).toContain("version: originalVersion");
    expect(route).toContain("status: originalStatus");
    expect(actions).toContain('"If-Match": rescheduleFromVersion');
    expect(actions).toContain("rescheduleFromAppointmentId }");
    expect(actions).not.toContain("rescheduleCancelOperationKey");
    expect(actions).not.toContain("old_booking_cancel_failed");
    expect(bookingPage).toContain("moves your booking in one step");
    expect(bookingPage).toContain('name="rescheduleFrom"');
  });

  it("queues creation, confirmation, audit, and staff work atomically", () => {
    const route = source("app/api/portal/bookings/route.ts");
    expect(route).toContain('request.headers.get("idempotency-key")');
    expect(route).toContain("readBoundedJsonRequest(request");
    expect(route).toContain("pg_advisory_xact_lock");
    expect(route).toContain("createOperationKeyHash: operationKeyHash");
    expect(route).toContain("createRequestHash: requestHash");
    expect(route).toContain("countOverlappingAppointments({");
    expect(route).toContain("queuePartnerBookingStaffAlert(tx");
    expect(route).toContain("queueSystemOutboundMessage({");
    expect(route).toContain("db: tx");
    expect(route).toContain("auditAction = rescheduleFromAppointmentId");
    expect(route).toContain(': "partner.booking.created"');
    expect(route).toContain("action: auditAction");
    expect(route).toContain('authMethod: "partner_session"');
    expect(route).not.toContain("sendSmsMessage");
    expect(route).not.toContain("team_member_phones");
    expect(route).not.toContain("resolveDevonPhone");
  });

  it("makes cancellation versioned, replay-safe, audited, and recoverable", () => {
    const route = source(
      "app/api/portal/bookings/[appointmentId]/cancel/route.ts",
    );
    expect(route).toContain('request.headers.get("idempotency-key")');
    expect(route).toContain('request.headers.get("if-match")');
    expect(route).toContain("readBoundedJsonRequest(request");
    expect(route).toContain("cancelOperationKeyHash: operationKeyHash");
    expect(route).toContain("version: row.bookingVersion + 1");
    expect(route).toContain("queuePartnerBookingStaffAlert(tx");
    expect(route).toContain('type: "estimate.status_changed"');
    expect(route).toContain('type: "appointment.calendar_sync_requested"');
    expect(route).toContain('action: "partner.booking.canceled"');
    expect(route).toContain('requiredPermission: "partner.bookings.cancel"');
    expect(route).not.toContain("sendSmsMessage");
    expect(route).not.toContain("team_member_phones");
    expect(route).not.toContain("resolveDevonPhone");
  });

  it("dispatches staff alerts through an uncertainty-safe outbox operation", () => {
    const operation = source("src/lib/staff-notification-operations.ts");
    const outbox = source("src/lib/outbox-processor.ts");
    const migration = source(
      "src/db/migrations/0096_partner_booking_staff_alert_integrity.sql",
    );
    expect(operation).toContain('state: "dispatched"');
    expect(operation).toContain('state: "reconciliation_required"');
    expect(operation).toContain('deliveryCertainty: "uncertain"');
    expect(operation).toContain(
      'action: "staff_notification.dispatch.succeeded"',
    );
    expect(operation).toContain("recipientTeamMemberId");
    expect(operation).not.toContain("team_member_phones");
    expect(outbox).toContain('case "staff_notification.dispatch"');
    expect(outbox).toContain("prepareStaffNotificationDispatch");
    expect(outbox).toContain("finalizeStaffNotificationDispatch");
    expect(outbox).toContain('getTeamOperationKillSwitchForRisk("external")');
    expect(migration).toContain('"staff_notification_operations"');
    expect(migration).toContain("'reconciliation_required'");
    expect(migration).toContain("'partner_session'");
  });

  it("exposes a versioned operator reconciliation endpoint without redispatch", () => {
    const route = source(
      "app/api/admin/partners/staff-notifications/reconciliation/route.ts",
    );
    expect(route).toContain('requirePermission(request, "partners.write")');
    expect(route).toContain("beginTeamMutation(request");
    expect(route).toContain('requiredPermissions: ["partners.write"]');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain(
      'auditAction: "partner.staff_notification.reconciled"',
    );
    expect(route).toContain(
      "requireTimestampVersion(mutation.expectedVersion)",
    );
    expect(route).toContain("claimTeamMutationIdempotency(");
    expect(route).toContain("eq(staffNotificationOperations.updatedAt");
    expect(route).toContain("Use the bound provider message ID");
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency(");
    expect(route).toContain("recipientAddressMasked");
    expect(route).toContain("providerCalled: false");
    expect(route).toContain("redispatchEnqueued: false");
    expect(route).toContain("redispatchAllowed: false");
    expect(route).not.toContain("queuePartnerBookingStaffAlert");
    expect(route).not.toContain("outboxEvents");
    expect(route).not.toContain("sendSmsMessage");
  });

  it("sends stable browser operation/version evidence and validates receipts", () => {
    const actions = source("../site/src/app/partners/actions.ts");
    const bookingPage = source("../site/src/app/partners/book/page.tsx");
    const bookingsPage = source("../site/src/app/partners/bookings/page.tsx");
    const cancelForm = source(
      "../site/src/app/partners/bookings/CancelBookingForm.tsx",
    );
    expect(actions).toContain('"Idempotency-Key": operationKey');
    expect(actions).toContain('"If-Match": version');
    expect(actions).toContain('"If-Match": rescheduleFromVersion');
    expect(actions).toContain("booking_confirmation_invalid");
    expect(actions).toContain("cancel_confirmation_invalid");
    expect(bookingPage).toContain('name="operationKey"');
    expect(bookingPage).toContain('name="rescheduleFromVersion"');
    expect(bookingsPage).toContain("rescheduleVersion: String(b.version)");
    expect(cancelForm).toContain('name="version"');
    expect(cancelForm).toContain('pendingLabel="Canceling…"');
  });
});
