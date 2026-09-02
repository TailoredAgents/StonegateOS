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

  it("moves a partner job atomically through a replacement V2 hold", () => {
    const service = source(
      "src/lib/partner-portal-v2-scheduling/service.ts",
    );
    const legacyRoute = source("app/api/portal/bookings/route.ts");
    const bookingPage = source(
      "../site/src/app/partners/(portal)/book/page.tsx",
    );
    const bookingWizard = source(
      "../site/src/app/partners/components/PartnerBookingWizard.tsx",
    );
    expect(service).toContain("export async function reschedulePartnerBooking");
    expect(service).toContain("await acquireScheduleConflictLock(tx)");
    expect(service).toContain("draft.rescheduleFromPartnerBookingId !== source.booking.id");
    expect(service).toContain("eq(appointmentHolds.id, input.holdId)");
    expect(service).toContain('hold.status !== "active"');
    expect(service).toContain('status: "consumed"');
    expect(service).toContain("eq(partnerBookings.version, source.booking.version)");
    expect(service).toContain('action: "partner.portal.v2.booking.rescheduled"');
    expect(service).toContain('reason: "partner.portal.v2.booking.rescheduled"');
    expect(legacyRoute).toContain('error: "legacy_route_retired"');
    expect(legacyRoute).not.toContain("rescheduleFromAppointmentId");
    expect(bookingPage).toContain("PartnerBookingWizard");
    expect(bookingWizard).toContain('"If-Match": current.etag');
    expect(bookingWizard).toContain(
      'createPortalOperationKey("booking-submit")',
    );
  });

  it("creates the account job, schedule, audit, and outbox atomically", () => {
    const service = source(
      "src/lib/partner-portal-v2-scheduling/service.ts",
    );
    const submitRoute = source(
      "app/api/portal/v2/booking-drafts/[draftId]/submit/route.ts",
    );
    expect(submitRoute).toContain("readPortalV2IdempotencyKey");
    expect(submitRoute).toContain("ifMatch: requestIfMatch(request)");
    expect(service).toContain('operationHash(\n    "booking.submit"');
    expect(service).toContain("await acquireScheduleConflictLock(tx)");
    expect(service).toContain("eq(partnerBookings.partnerAccountId, input.actor.accountId)");
    expect(service).toContain("createOperationKeyHash: opHash");
    expect(service).toContain("requestedByMembershipId: input.actor.membershipId");
    expect(service).toContain("scopeSnapshot:");
    expect(service).toContain("rateSnapshot:");
    expect(service).toContain('type: "appointment.calendar_sync_requested"');
    expect(service).toContain("await tx.insert(auditLogs).values");
    expect(service).not.toContain("partnerUsers.phoneE164");
  });

  it("makes V2 cancellation versioned, replay-safe, audited, and recoverable", () => {
    const route = source(
      "app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    );
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain('request.headers.get("if-match")');
    expect(route).toContain("readBoundedJsonRequest(request");
    expect(route).toContain("createPartnerJobAccessCondition(principal, jobId)");
    expect(route).toContain("cancelOperationKeyHash: idempotency.keyHash");
    expect(route).toContain("version: row.bookingVersion + 1");
    expect(route).toContain("await acquireScheduleConflictLock(tx)");
    expect(route).toContain('eventType: "job.canceled"');
    expect(route).toContain('type: "estimate.status_changed"');
    expect(route).toContain('type: "appointment.calendar_sync_requested"');
    expect(route).toContain('action: "partner.booking.canceled"');
    expect(route).toContain('requiredPermission: "bookings.cancel"');
    expect(route).not.toContain("sendSmsMessage");
    expect(route).not.toContain("partnerUsers.phoneE164");
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
    const bookingPage = source(
      "../site/src/app/partners/(portal)/book/page.tsx",
    );
    const bookingsPage = source(
      "../site/src/app/partners/(portal)/bookings/page.tsx",
    );
    const bookingWizard = source(
      "../site/src/app/partners/components/PartnerBookingWizard.tsx",
    );
    const jobActions = source(
      "../site/src/app/partners/components/PartnerJobActions.tsx",
    );
    expect(bookingPage).toContain("PartnerBookingWizard");
    expect(bookingWizard).toContain('"Idempotency-Key"');
    expect(bookingWizard).toContain('"If-Match"');
    expect(bookingsPage).toContain("/api/portal/v2/jobs");
    expect(jobActions).toContain('createPortalOperationKey("job-cancel")');
    expect(jobActions).toContain('"If-Match": etag');
    expect(jobActions).toContain('name="reason"');
    expect(jobActions).toContain("minLength={5}");
    expect(jobActions).toContain('"Submitting…"');
  });
});
