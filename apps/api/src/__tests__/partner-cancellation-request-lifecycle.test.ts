import fs from "node:fs";
import path from "node:path";
import { createPartnerCancellationRequestSnapshot } from "@/lib/partner-cancellation-request-lifecycle";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Partner cancellation request lifecycle contract", () => {
  it("creates a bounded immutable policy and schedule snapshot", () => {
    const requestedAt = new Date("2035-06-01T12:00:00.000Z");
    const snapshot = createPartnerCancellationRequestSnapshot({
      requestedAt,
      publicStatus: "confirmed",
      appointmentStatus: "confirmed",
      bookingVersion: 7,
      promisedArrivalStartAt: new Date("2035-06-02T12:00:00.000Z"),
      promisedArrivalEndAt: new Date("2035-06-02T14:00:00.000Z"),
      timezone: "America/New_York",
      cutoffMinutes: 1_440,
      directCancellationEnabled: true,
      policySource: "configured",
      policyRevision: 3,
      deadlineAt: "2035-06-01T12:00:00.000Z",
      decisionReasonCode: "cutoff_elapsed",
    });
    expect(snapshot).toEqual({
      version: 1,
      requestedAt: requestedAt.toISOString(),
      job: {
        publicStatus: "confirmed",
        appointmentStatus: "confirmed",
        bookingVersion: 7,
      },
      schedule: {
        promisedArrivalStartAt: "2035-06-02T12:00:00.000Z",
        promisedArrivalEndAt: "2035-06-02T14:00:00.000Z",
        timezone: "America/New_York",
      },
      policy: {
        cutoffMinutes: 1_440,
        directCancellationEnabled: true,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: null,
        source: "configured",
        revision: 3,
        deadlineAt: "2035-06-01T12:00:00.000Z",
        decisionReasonCode: "cutoff_elapsed",
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
  });

  it("keeps creation and Staff resolution under the canonical schedule lock", () => {
    const partnerRoute = source(
      "app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    );
    const lifecycle = source(
      "src/lib/partner-cancellation-request-lifecycle.ts",
    );
    const decisionStart = lifecycle.indexOf(
      "export async function decidePartnerCancellationRequestAsStaff",
    );
    const scheduleLock = lifecycle.indexOf(
      "acquireScheduleConflictLock(tx)",
      decisionStart,
    );
    const jobLock = lifecycle.indexOf(
      "acquirePartnerJobMutationLock",
      scheduleLock,
    );
    expect(
      partnerRoute.indexOf("acquireScheduleConflictLock(tx)"),
    ).toBeLessThan(
      partnerRoute.indexOf(".insert(partnerCancellationRequests)"),
    );
    expect(scheduleLock).toBeGreaterThan(decisionStart);
    expect(jobLock).toBeGreaterThan(scheduleLock);
    expect(jobLock).toBeLessThan(
      lifecycle.indexOf(".update(appointments)", jobLock),
    );
    expect(lifecycle).toContain("assertTeamMutationExpectedVersion");
    expect(lifecycle).toContain(
      'eq(partnerCancellationRequests.state, "pending")',
    );
    expect(lifecycle).toContain(
      "Superseded because Staff approved the cancellation request.",
    );
    expect(lifecycle).toContain(
      "supersedePendingPartnerJobChangeRequestForCancellation(tx",
    );
  });

  it("requires granular recent-MFA Staff authority and immutable typed decisions", () => {
    const route = source(
      "app/api/admin/partner-management/v1/cancellation-requests/[requestId]/decision/route.ts",
    );
    expect(route).toContain(
      'requiredPermissions: ["partners.cancellation_requests.decide"]',
    );
    expect(route).toContain('risk: "destructive"');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(route).toContain("readBoundedJsonRequest");
    expect(route).toContain("mutation.expectedVersion");
    expect(route).toContain("APPROVE CANCELLATION");
    expect(route).toContain("DECLINE CANCELLATION");
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency");
  });

  it("quarantines legacy hashes and derives Partner state only from canonical rows", () => {
    const migration = source(
      "src/db/migrations/0149_partner_cancellation_request_lifecycle.sql",
    );
    const list = source("app/api/portal/v2/jobs/route.ts");
    const detail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    expect(migration).toContain(
      'CREATE TABLE "partner_cancellation_request_reconciliation_cases"',
    );
    expect(migration).toContain(
      "partner_cancellation_request_resolution_immutable",
    );
    expect(migration).not.toContain(
      'INSERT INTO "partner_cancellation_requests"',
    );
    for (const route of [list, detail]) {
      expect(route).toContain("partnerCancellationRequests");
      expect(route).toContain("partnerCancellationRequestReconciliationCases");
      expect(route).toContain('state: "reconciliation_required"');
      expect(route).not.toContain("Boolean(job.cancelOperationKeyHash)");
    }
  });

  it("records a public event plus a Partner notification/outbox for both decisions", () => {
    const lifecycle = source(
      "src/lib/partner-cancellation-request-lifecycle.ts",
    );
    expect(lifecycle).toContain("job.cancellation_request_approved");
    expect(lifecycle).toContain("job.cancellation_request_declined");
    expect(lifecycle).toContain("queuePartnerBookingNotification");
    expect(lifecycle).toContain(".insert(partnerNotifications)");
    expect(lifecycle).toContain("partner.cancellation_request.resolved");
    expect(lifecycle).toContain(
      "The existing schedule remains in place. Open the job for current details.",
    );
  });
});
