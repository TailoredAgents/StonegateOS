import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PARTNER_PORTAL_E2E_INVOICE_STATES,
  PARTNER_PORTAL_E2E_JOB_STATES,
  PARTNER_PORTAL_E2E_MATRIX_VERSION,
  PARTNER_PORTAL_E2E_MEMBER_MATRIX,
  PARTNER_PORTAL_E2E_PASSWORD,
  partnerPortalFixtureEmails,
  partnerPortalSessionToken,
  readPartnerPortalE2ESeedSummary,
} from "../../../../scripts/seed-partner-portal-e2e";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const source = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("Partner Portal deterministic E2E seed manifest", () => {
  it("covers the six launch roles and all four primary personas", () => {
    const activeRoles = new Set(
      PARTNER_PORTAL_E2E_MEMBER_MATRIX.filter(
        (member) => member.status === "active",
      ).map((member) => member.roleKey),
    );
    expect(
      [
        "admin",
        "scheduler",
        "requester",
        "approver",
        "billing",
        "viewer",
      ].every((role) => activeRoles.has(role)),
    ).toBe(true);
    const personas = new Set(
      PARTNER_PORTAL_E2E_MEMBER_MATRIX.map((member) => member.persona),
    );
    expect(personas).toEqual(
      new Set([
        "contractor",
        "real_estate_agent",
        "property_manager",
        "commercial_client",
      ]),
    );
  });

  it("contains approved, limited, suspended, and multi-account actors without MFA flags", () => {
    expect(PARTNER_PORTAL_E2E_MEMBER_MATRIX).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "limited",
          roleKey: "applicant",
          status: "active",
        }),
        expect.objectContaining({ key: "suspended", status: "suspended" }),
        expect.objectContaining({ key: "admin", status: "active" }),
        expect.objectContaining({ key: "approver", status: "active" }),
        expect.objectContaining({ key: "billing", status: "active" }),
      ]),
    );
    expect(
      PARTNER_PORTAL_E2E_MEMBER_MATRIX.every(
        (member) => !("mfaRequired" in member),
      ),
    ).toBe(true);
    const implementation = source("scripts/seed-partner-portal-e2e.ts");
    expect(implementation).toContain("membershipIds.admin_secondary");
    expect(implementation).toContain('authMethod: "password"');
    expect(implementation).toContain('assuranceLevel: "aal1"');
    expect(implementation).not.toContain("partnerMfaMethods");
  });

  it("covers every public job state plus representative billing states", () => {
    expect(PARTNER_PORTAL_E2E_JOB_STATES).toEqual([
      "requested",
      "approval_needed",
      "under_review",
      "confirmed",
      "en_route",
      "in_progress",
      "completed",
      "canceled",
      "declined",
    ]);
    expect(PARTNER_PORTAL_E2E_INVOICE_STATES).toEqual([
      "issued",
      "partially_paid",
      "paid",
      "overdue",
    ]);
  });

  it("derives stable, distinct local-only emails and sessions without persisting raw tokens", () => {
    const runId = "portal-matrix-test";
    const emails = partnerPortalFixtureEmails(runId);
    expect(new Set(emails).size).toBe(PARTNER_PORTAL_E2E_MEMBER_MATRIX.length);
    expect(
      emails.every((email) =>
        /^e2e\+portal-[a-z0-9-]+@mystos\.test$/u.test(email),
      ),
    ).toBe(true);
    expect(PARTNER_PORTAL_E2E_PASSWORD).toMatch(/^E2E-/u);
    expect(partnerPortalSessionToken(runId, "admin")).toBe(
      partnerPortalSessionToken(runId, "admin"),
    );
    expect(partnerPortalSessionToken(runId, "admin")).not.toBe(
      partnerPortalSessionToken(runId, "billing"),
    );
    const seed = source("scripts/seed-e2e.ts");
    expect(seed).not.toContain("PARTNER_PORTAL_E2E_PASSWORD");
    expect(seed).not.toContain("partnerPortalSessionToken");
    expect(seed).toContain("payload: { ...summary, runId }");
  });

  it("rejects incomplete receipts before any reusable fixture is trusted", () => {
    expect(
      readPartnerPortalE2ESeedSummary({
        matrixVersion: PARTNER_PORTAL_E2E_MATRIX_VERSION,
      }),
    ).toBeNull();
    const integration = source("scripts/seed-e2e.ts");
    expect(integration).toContain("assertPartnerPortalE2EMatrix");
    expect(integration).toContain("expectedEmails");
    expect(integration).toContain(
      "setup will not guess at or overwrite an unverified fixture",
    );
  });
});

describe("Partner Portal E2E seed safety and cleanup", () => {
  const integration = source("scripts/seed-e2e.ts");
  const implementation = source("scripts/seed-partner-portal-e2e.ts");
  const cleanup = source("scripts/cleanup-e2e.ts");

  it("is restricted to the disposable sentinel and refuses production runtime", () => {
    expect(integration).toContain("assertIsolatedE2ESeedTarget");
    expect(integration).toContain("configured !== sentinel");
    expect(integration).toContain('process.env["NODE_ENV"] === "production"');
    expect(integration).toContain("local E2E data only");
  });

  it("seeds account-owned locations, approval, proof, jobs, billing, and canonical properties", () => {
    expect(implementation).toContain("resolveOrCreateContactProperty");
    expect(implementation).toContain("partnerAccountLocations");
    expect(implementation).toContain("partnerEvidenceRequirements");
    expect(implementation).toContain("partnerApprovalRequests");
    expect(implementation).toContain("partnerJobEvents");
    expect(implementation).toContain("partnerInvoices");
    expect(implementation).toContain("partnerInvoiceLines");
  });

  it("archives and disables portal identities without hard-deleting retained records", () => {
    expect(cleanup).toContain("partnerUsersDeactivated");
    expect(cleanup).toContain("partnerMembershipsSuspended");
    expect(cleanup).toContain("partnerApplicationsWithdrawn");
    expect(cleanup).toContain("partnerSessionsRevoked");
    expect(cleanup).toContain("archived-e2e-session:");
    expect(cleanup).toContain("partnerAccountsDisabled");
    expect(cleanup).not.toContain(".delete(partnerUsers)");
    expect(cleanup).not.toContain(".delete(partnerAccountMemberships)");
    expect(cleanup).not.toContain(".delete(contacts)");
  });
});
