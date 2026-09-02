import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Partner job change request lifecycle", () => {
  it("keeps Partner request and reference mutations bounded, revision-safe, and capability-gated", () => {
    const changeRoute = source(
      "app/api/portal/v2/jobs/[jobId]/change-requests/route.ts",
    );
    const referenceRoute = source(
      "app/api/portal/v2/jobs/[jobId]/references/route.ts",
    );
    const lifecycle = source("src/lib/partner-job-change-request-lifecycle.ts");

    expect(changeRoute).toContain('"jobs.change_request"');
    expect(referenceRoute).toContain('"commercial.edit"');
    for (const route of [changeRoute, referenceRoute]) {
      expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
      expect(route).toContain("readBoundedJsonRequest");
      expect(route).toContain("rejectDuplicateObjectKeys: true");
      expect(route).toContain("readPortalV2IdempotencyKey");
      expect(route).toContain('request.headers.get("if-match")');
    }
    expect(lifecycle).toContain("acquirePartnerJobMutationLock");
    expect(lifecycle).toContain("await acquireScheduleConflictLock(tx)");
    expect(lifecycle).toContain("createPartnerJobAccessCondition");
    expect(lifecycle).toContain("assertCurrentPartnerRevision");
    expect(lifecycle).toContain("PartnerJobChangeRequestBodySchema");
    expect(lifecycle).not.toContain("orgContactId:");
  });

  it("permits Staff to apply only validated public fields and routes material changes to a change order", () => {
    const route = source(
      "app/api/admin/partner-management/v1/change-requests/[requestId]/decision/route.ts",
    );
    const lifecycle = source("src/lib/partner-job-change-request-lifecycle.ts");
    expect(route).toContain(
      'requiredPermissions: ["partners.change_requests.decide"]',
    );
    expect(route).toContain('risk: "destructive"');
    expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("mutation.expectedVersion");
    expect(route).toContain("APPROVE JOB CHANGE");
    expect(route).toContain("DECLINE JOB CHANGE");
    expect(route).toContain("REQUIRE CHANGE ORDER");
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency");

    expect(lifecycle).toContain("partnerJobChangeRequiresChangeOrder");
    expect(lifecycle).toContain("applyApprovedPartnerJobPublicChanges");
    expect(lifecycle).toContain("partnerJobChangeSnapshotStillMatches");
    expect(lifecycle).toContain("job.change_order_required");
    expect(lifecycle).toContain(".insert(partnerNotifications)");
    expect(lifecycle).toContain('type: "partner.job_change_request.resolved"');
    expect(lifecycle).toContain(
      "supersedePendingPartnerJobChangeRequestForCancellation",
    );
    expect(lifecycle).toContain(
      'input.decision === "approved" &&\n    isJobTerminal',
    );
  });

  it("adds a truthful immutable cancellation-superseded state and never hard-codes replay state", () => {
    const migration = source(
      "src/db/migrations/0155_partner_job_change_request_cancellation_resolution.sql",
    );
    const lifecycle = source("src/lib/partner-job-change-request-lifecycle.ts");
    const route = source(
      "app/api/portal/v2/jobs/[jobId]/change-requests/route.ts",
    );
    expect(migration).toContain("'superseded'");
    expect(migration).toContain("'partner_direct_cancellation'");
    expect(migration).toContain("'staff_approved_cancellation'");
    expect(migration).toContain(
      "partner_job_change_request_resolution_immutable",
    );
    expect(lifecycle).toContain("state: replay.state");
    expect(lifecycle).toContain("requestRevision: replay.revision");
    expect(lifecycle).toContain("bookingRevision: job.version");
    expect(lifecycle).toContain("bookingUpdatedAt: job.updatedAt");
    expect(lifecycle).not.toContain(
      "requestRevision: 1,\n      bookingRevision: replay",
    );
    expect(route).toContain("resolution: result.resolution");
    expect(route).toContain('state === "superseded"');
    expect(route).toContain('"idempotency-replayed": "true"');
  });

  it("persists immutable account-owned evidence with pending uniqueness and paired idempotency", () => {
    const migration = source(
      "src/db/migrations/0152_partner_job_change_requests.sql",
    );
    expect(migration).toContain('CREATE TABLE "partner_job_change_requests"');
    expect(migration).toContain(
      'CONSTRAINT "partner_job_change_requests_booking_account_fk"',
    );
    expect(migration).toContain(
      'CONSTRAINT "partner_job_change_requests_requester_account_fk"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "partner_job_change_requests_account_operation_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "partner_job_change_requests_pending_booking_key"',
    );
    expect(migration).toContain(
      "partner_job_change_request_evidence_immutable",
    );
    expect(migration).toContain(
      "partner_job_change_request_resolution_immutable",
    );
  });

  it("projects pending state and explainable actions without internal appointment IDs", () => {
    const list = source("app/api/portal/v2/jobs/route.ts");
    const detail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    const policy = source("src/lib/partner-portal-v2-job-actions.ts");
    for (const route of [list, detail]) {
      expect(route).toContain("partnerJobChangeRequests");
      expect(route).toContain("changeRequestPending");
      expect(route).toContain(
        'requestChange: hasPartnerCapability(principal, "jobs.change_request")',
      );
      expect(route).toContain(
        'editReferences: hasPartnerCapability(principal, "commercial.edit")',
      );
    }
    expect(policy).toContain('"request_change"');
    expect(policy).toContain('"edit_references"');
    expect(policy).toContain('"change_request_pending"');
  });

  it("wires the bounded Staff queue and decision forms into Partner administration", () => {
    const workspace = source(
      "../site/src/app/team/components/PartnerAdministrationSection.tsx",
    );
    const actions = source(
      "../site/src/app/team/actions/partner-administration.ts",
    );
    expect(workspace).toContain('id: "change-requests"');
    expect(workspace).toContain('"partners.change_requests.read"');
    expect(workspace).toContain('"partners.change_requests.decide"');
    expect(workspace).toContain("Proposed public fields");
    expect(workspace).toContain("Declared material impacts");
    expect(workspace).toContain("APPROVE JOB CHANGE");
    expect(workspace).toContain("REQUIRE CHANGE ORDER");
    expect(workspace).toContain("DECLINE JOB CHANGE");
    expect(actions).toContain(
      "export async function partnerJobChangeRequestDecisionAction",
    );
    expect(actions).toContain(
      "/api/admin/partner-management/v1/change-requests/${encodeURIComponent(requestId)}/decision",
    );
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.change_requests.decide")',
    );
  });
});
