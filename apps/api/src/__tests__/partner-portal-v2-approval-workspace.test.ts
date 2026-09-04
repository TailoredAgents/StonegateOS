import fs from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

describe("partner portal V2 approval workspace contract", () => {
  it.each([
    "app/api/portal/v2/approval-requests/route.ts",
    "app/api/portal/v2/approval-requests/[requestId]/route.ts",
  ])("requires approval-read capability without an MFA gate in %s", (file) => {
    const route = source(file);
    expect(route).toContain('"approvals.read"');
    expect(route).toContain("requirePartnerCapability");
    expect(route).not.toMatch(/mfa|aal2/iu);
  });

  it("requires approval-decision capability without an MFA gate", () => {
    const route = source(
      "app/api/portal/v2/approval-requests/[requestId]/decision/route.ts",
    );
    expect(route).toContain('"approvals.decide"');
    expect(route).toContain("requirePartnerCapability");
    expect(route).not.toMatch(/mfa|aal2/iu);
  });

  it("uses account-scoped reads and a safe request-snapshot allowlist", () => {
    const service = source("src/lib/partner-portal-v2-approvals.ts");
    expect(service).toContain(
      "eq(partnerApprovalRequests.partnerAccountId, input.accountId)",
    );
    expect(service).toContain("summarizedRequestSnapshot");
    expect(service).toContain("displayName: partnerUsers.name");
    expect(service).toContain(
      "eq(partnerAccountMemberships.partnerAccountId, accountId)",
    );
    expect(service).toContain('"amountMinor"');
    expect(service).toContain('"description"');
    expect(service).not.toMatch(/request:\s*input\.row\.requestSnapshot/u);
    expect(service).not.toMatch(/\.\.\.input\.row\.requestSnapshot/u);
  });

  it("requires ETag and idempotency for immutable approval decisions", () => {
    const route = source(
      "app/api/portal/v2/approval-requests/[requestId]/decision/route.ts",
    );
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain('request.headers.get("if-match")');
    expect(route).toContain("runPortalV2IdempotentMutation");
  });

  it("prohibits self-approval and applies the final decision lifecycle atomically", () => {
    const service = source("src/lib/partner-portal-v2-approvals.ts");
    expect(service).toContain(
      "requestRow.requestedByMembershipId === input.membershipId",
    );
    expect(service).toContain(
      "decision.decidedByMembershipId === input.membershipId",
    );
    expect(service).toContain("await acquireScheduleConflictLock(tx)");
    expect(service).toContain('kind: "approved_needs_reschedule"');

    const lifecycle = service.slice(
      service.indexOf("async function applyPartnerApprovalLifecycle"),
      service.indexOf("export async function decidePartnerApprovalRequest"),
    );
    expect(lifecycle).toContain('status: "consumed"');
    expect(lifecycle).toContain('status: "confirmed"');
    expect(lifecycle).toContain('publicStatus: "confirmed"');
    expect(lifecycle).toContain('status: "released"');
    expect(lifecycle).toContain('status: "canceled"');
    expect(lifecycle).toContain('publicStatus: "declined"');
    expect(lifecycle).toContain('eventType: "job.approval_confirmed"');
    expect(lifecycle).toContain('type: "appointment.calendar_sync_requested"');
    expect(lifecycle).not.toContain(".transaction(");
    const noPromiseGuard = lifecycle.indexOf(
      'if (input.plan.kind === "approved_needs_reschedule") return',
    );
    expect(noPromiseGuard).toBeGreaterThan(-1);
    expect(lifecycle.indexOf("partnerJobEvents")).toBeGreaterThan(
      noPromiseGuard,
    );
    expect(lifecycle.indexOf("outboxEvents")).toBeGreaterThan(noPromiseGuard);

    const decision = service.slice(
      service.indexOf("export async function decidePartnerApprovalRequest"),
    );
    const publicResponse = decision.slice(
      decision.indexOf("body: {\n        ok: true"),
      decision.indexOf("headers: { ETag: etag }"),
    );
    expect(publicResponse).not.toMatch(
      /appointmentId|startAt|arrivalWindow|schedulePolicy/u,
    );
  });
});
