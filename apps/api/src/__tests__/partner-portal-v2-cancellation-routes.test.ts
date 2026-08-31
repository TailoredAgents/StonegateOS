import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("partner portal V2 cancellation route contracts", () => {
  it("serializes cancel versus confirm and rechecks both appointment state and job revision", () => {
    const route = source("app/api/portal/v2/jobs/[jobId]/cancel/route.ts");
    const lock = route.indexOf("await acquireScheduleConflictLock(tx)");
    const lockedRead = route.indexOf(".from(partnerBookings)", lock);
    const appointmentWrite = route.indexOf(".update(appointments)", lockedRead);

    expect(lock).toBeGreaterThan(0);
    expect(lockedRead).toBeGreaterThan(lock);
    expect(appointmentWrite).toBeGreaterThan(lockedRead);
    expect(route).toContain("eq(appointments.status, row.appointmentStatus)");
    expect(route).toContain("eq(partnerBookings.version, row.bookingVersion)");
    expect(route).toContain('throw new Error("partner_cancel_revision_race")');
  });

  it("keeps origin, tenant-safe access, idempotency, and revision checks ahead of mutation", () => {
    const route = source("app/api/portal/v2/jobs/[jobId]/cancel/route.ts");
    const origin = route.indexOf("isAllowedPartnerPortalMutationOrigin");
    const scope = route.indexOf("await hasPartnerJobAccess(principal, jobId)");
    const idempotency = route.indexOf("readPortalV2IdempotencyKey", scope);
    const precondition = route.indexOf(
      "evaluatePortalV2RevisionPrecondition",
      idempotency,
    );
    const mutation = route.indexOf(".update(partnerBookings)", precondition);

    expect(origin).toBeGreaterThan(0);
    expect(scope).toBeGreaterThan(origin);
    expect(idempotency).toBeGreaterThan(scope);
    expect(precondition).toBeGreaterThan(idempotency);
    expect(mutation).toBeGreaterThan(precondition);
    expect(route).toMatch(/"not_found",\s+404,/u);
  });

  it("persists late cancellation as review work without canceling the appointment or charging", () => {
    const route = source("app/api/portal/v2/jobs/[jobId]/cancel/route.ts");
    const processor = source("src/lib/outbox-processor.ts");
    const reviewStart = route.indexOf(
      'cancellation.action === "request_cancellation_review"',
    );
    const directCancellation = route.indexOf(
      ".update(appointments)",
      reviewStart,
    );
    const reviewReturn = route.indexOf(
      'outcome: "review_requested"',
      reviewStart,
    );

    expect(reviewStart).toBeGreaterThan(0);
    expect(reviewReturn).toBeGreaterThan(reviewStart);
    expect(reviewReturn).toBeLessThan(directCancellation);
    expect(route).toContain('"cancellation_review_requested"');
    expect(route).toContain('type: "partner.cancellation_review_requested"');
    expect(route).toContain("automaticFeeMinor: null");
    expect(processor).toContain('case "partner.cancellation_review_requested"');
    expect(processor).toContain("Review partner cancellation request");
    expect(processor).toContain("isNotNull(partnerBookings.cancelRequestHash)");
  });

  it("publishes the same policy decision in list/detail DTOs and accessible job actions", () => {
    const list = source("app/api/portal/v2/jobs/route.ts");
    const detail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    const actions = source(
      "../site/src/app/partners/components/PartnerJobActions.tsx",
    );
    const policy = source("src/lib/partner-portal-v2-cancellation.ts");

    for (const route of [list, detail]) {
      expect(route).toContain("evaluatePartnerCancellation({");
      expect(route).toContain("resolvePartnerCancellationPolicy");
      expect(route).toContain("cancellation,");
      expect(route).toContain("cancellationAction: cancellation.action");
    }
    expect(actions).toContain(
      'aria-labelledby="partner-cancellation-policy-title"',
    );
    expect(actions).toContain(
      'aria-describedby="partner-cancellation-consequence"',
    );
    expect(policy).toContain("No fee is applied automatically");
    expect(actions).toContain('"request_cancellation_review"');
  });
});
