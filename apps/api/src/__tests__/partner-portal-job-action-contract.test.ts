import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner job action public contract", () => {
  it("derives explainable detail actions from lifecycle, appointment, review, proof, revision, and capability state", () => {
    const route = source("apps/api/app/api/portal/v2/jobs/[jobId]/route.ts");
    const listRoute = source("apps/api/app/api/portal/v2/jobs/route.ts");
    expect(route).toContain("resolvePartnerJobActionAvailability");
    expect(route).toContain("appointmentStatus: appointments.status");
    expect(route).toContain('partnerRescheduleRequests.state, "pending"');
    expect(route).toContain("proofAvailable: proofPackages.length > 0");
    expect(route).toContain("cancellationReviewPending");
    expect(route).toContain("actionAvailability,");
    expect(route).toContain(
      "allowedActions: allowedPartnerJobActions(actionAvailability)",
    );
    expect(route).not.toContain("function allowedActions(");
    expect(listRoute).toContain("resolvePartnerJobActionAvailability");
    expect(listRoute).toContain("appointmentStatus: appointments.status");
    expect(listRoute).toContain("proofAvailable: sql<boolean>`exists");
    expect(listRoute).toContain('partnerRescheduleRequests.state, "pending"');
    expect(listRoute).toContain(
      "allowedActions: allowedPartnerJobActions(actionAvailability)",
    );
    expect(listRoute).not.toContain("function publicJobActions(");
  });

  it("fails the job page closed on malformed descriptors and explains relevant unavailable actions", () => {
    const page = source(
      "apps/site/src/app/partners/(portal)/bookings/[jobId]/page.tsx",
    );
    const actions = source(
      "apps/site/src/app/partners/components/PartnerJobActions.tsx",
    );
    expect(page).toContain("parsePartnerJobActionAvailability");
    expect(page).toContain("actionAvailability={job.actionAvailability}");
    expect(actions).toContain("findPartnerJobAction");
    expect(actions).toContain("Why some actions are unavailable");
    expect(actions).toContain("available_review_required");
    expect(actions).toContain("Refresh this job to load its latest revision");
  });

  it("seeds and verifies pending cancellation review from the durable request lifecycle", () => {
    const fixtures = source("tests/e2e/audit/partner-booking-fixtures.ts");
    const createStart = fixtures.indexOf(
      "export async function createPartnerJobActionFixture",
    );
    const createEnd = fixtures.indexOf(
      "export async function configurePartnerApprovalFixture",
      createStart,
    );
    const snapshotStart = fixtures.indexOf(
      "export async function getPartnerJobActionFixtureSnapshot",
    );
    const snapshotEnd = fixtures.indexOf(
      "export async function cleanupPartnerJobActionFixture",
      snapshotStart,
    );

    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(snapshotStart).toBeGreaterThanOrEqual(0);
    expect(snapshotEnd).toBeGreaterThan(snapshotStart);

    const createFixture = fixtures.slice(createStart, createEnd);
    const snapshotFixture = fixtures.slice(snapshotStart, snapshotEnd);
    expect(createFixture).toContain(
      "INSERT INTO partner_cancellation_requests",
    );
    expect(createFixture).toContain("requested_by_membership_id");
    expect(createFixture).toContain("request_snapshot");
    expect(createFixture).not.toContain("cancel_operation_key_hash");
    expect(createFixture).not.toContain("cancel_request_hash");
    expect(snapshotFixture).toContain(
      "FROM partner_cancellation_requests AS cancellation_request",
    );
    expect(snapshotFixture).toContain("cancellation_request.state = 'pending'");
    expect(snapshotFixture).not.toContain(
      "booking.cancel_operation_key_hash IS NOT NULL",
    );
  });
});
