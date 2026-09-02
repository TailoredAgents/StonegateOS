import fs from "node:fs";
import path from "node:path";

const SITE_TEAM_ROOT = path.resolve(process.cwd(), "../site/src/app/team");

function siteSource(relativePath: string): string {
  return fs.readFileSync(path.join(SITE_TEAM_ROOT, relativePath), "utf8");
}

describe("Team Partner administration UI mutation contract", () => {
  const actions = siteSource("actions/partner-administration.ts");
  const controls = siteSource("components/PartnerAdministrationMutations.tsx");
  const workspace = siteSource("components/PartnerAdministrationSection.tsx");

  it("exposes a granular Domains directory and permission-gated controls", () => {
    expect(workspace).toContain('id: "domains"');
    expect(workspace).toContain('permission: "partners.domains.read"');
    expect(workspace).toContain('"partners.domains.manage"');
    expect(workspace).toContain('"partners.domains.verify"');
    expect(workspace).toContain('"partners.domains.revoke"');
    expect(workspace).toContain('"partners.domains.override"');
    expect(workspace).toContain("<PartnerDomainCreatePanel");
    expect(workspace).toContain("<PartnerDomainMutationControls");
    expect(workspace).toContain("<PartnerMembershipMutationControls");
    expect(workspace).toContain("/api/admin/partner-management/v1/accounts?");
  });

  it("exposes explicit lifecycle filtering without collapsing identity states", () => {
    expect(workspace).toContain("p_admin_status");
    for (const status of [
      "pending_activation",
      "active",
      "suspended",
      "disabled",
      "quarantined",
    ]) {
      expect(workspace).toContain(`"${status}"`);
    }
    expect(workspace).toContain('item["identityStatus"]');
    for (const status of ["active", "expired", "revoked"]) {
      expect(workspace).toContain(`"${status}"`);
    }
    expect(workspace).toContain('id: "security"');
    expect(workspace).toContain('permission: "partners.security.read"');
    expect(workspace).toContain('id: "quarantine"');
    expect(workspace).toContain('permission: "partners.quarantine.read"');
    expect(workspace).toContain('id: "commercial"');
    expect(workspace).toContain('permission: "partners.commercial.read"');
  });

  it("sends role and relational scope changes only to canonical V1 routes", () => {
    expect(actions).toContain("callAdminApiAs");
    expect(actions).toContain('"Idempotency-Key": input.idempotencyKey');
    expect(actions).toContain('"If-Match": input.expectedVersion');
    expect(actions).toContain(
      "/api/admin/partner-management/v1/memberships/${encodeURIComponent(common.membershipId)}/role",
    );
    expect(actions).toContain(
      "/api/admin/partner-management/v1/memberships/${encodeURIComponent(common.membershipId)}/scope",
    );
    expect(actions).toContain("locationIds");
    expect(actions).toContain("costCenterIds");
    expect(actions).not.toContain("/api/admin/partners/users");
  });

  it("requires owner authority for migrated owners and domain overrides", () => {
    expect(actions).toContain('"partners.memberships.recover_admin"');
    expect(actions).toContain('"partners.domains.override"');
    expect(controls).toContain("APPROVE MIGRATED OWNER");
    expect(controls).toContain("TRANSFER VERIFIED DOMAIN");
    expect(controls).toContain("RESTORE REVOKED DOMAIN");
    expect(controls).toContain("A Team Owner must approve");
  });

  it("uses explicit accessible confirmations and fresh render-scoped keys", () => {
    for (const phrase of [
      "UPDATE MEMBERSHIP ROLE",
      "UPDATE MEMBERSHIP SCOPE",
      "APPROVE MIGRATED MEMBERSHIP",
      "QUARANTINE MIGRATED MEMBERSHIP",
      "ADD COMPANY DOMAIN",
      "VERIFY COMPANY DOMAIN",
      "REVOKE COMPANY DOMAIN",
    ]) {
      expect(controls).toContain(phrase);
      expect(actions).toContain(phrase);
    }
    expect(controls).toContain("randomUUID()");
    expect(controls).toContain("min-h-[44px]");
    expect(controls).toContain("<SubmitButton");
    expect(controls).toContain("aria-describedby");
    expect(workspace).toContain("partnerSecuritySessionRevokeAction");
    expect(workspace).toContain("REVOKE PARTNER SESSION");
    expect(actions).toContain("REVOKE PARTNER SESSION");
    expect(workspace).toContain("Reason for revocation");
    expect(workspace).toContain("min-h-[44px]");
  });

  it("keeps single-session containment separate from membership and identity lifecycle", () => {
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.security.sessions.revoke")',
    );
    expect(actions).toContain(
      "/api/admin/partner-management/v1/security/sessions/${encodeURIComponent(sessionId)}/revoke",
    );
    expect(actions).toContain(
      "The person and company membership remain unchanged.",
    );
    expect(workspace).toContain("This signs out only this device session.");
    expect(workspace).toContain("global identity disable remains a");
  });

  it("renders quarantine risk and history while limiting mutation to evidence-backed resolution", () => {
    expect(workspace).toContain("Containment reason");
    expect(workspace).toContain("Recorded history");
    expect(workspace).toContain("Read-only containment");
    expect(workspace).toContain("Resolve provider uncertainty");
    expect(workspace).toContain("never calls a");
    expect(workspace).toContain("RESOLVE AS CONFIRMED SENT");
    expect(workspace).toContain("RESOLVE AS");
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.quarantine.release")',
    );
    expect(actions).toContain(
      "/api/admin/partner-management/v1/quarantine/${encodeURIComponent(caseId)}/resolve",
    );
    expect(actions).toContain("providerOperationIds.length > 10");
    expect(actions).toContain("No provider call was made.");
  });

  it("renders sanitized commercial readiness without speculative provider controls", () => {
    expect(workspace).toContain("Operational pricing");
    expect(workspace).toContain("Readiness findings");
    expect(workspace).toContain("Configuration evidence");
    expect(workspace).toContain("hosted-invoice gap");
    expect(workspace).toContain("provider payment configuration");
    expect(workspace).toContain("const canManageCommercial");
    expect(workspace).toContain('"partners.commercial.manage"');
    expect(workspace).toContain("PartnerApprovalRuleManager");
    expect(workspace).toContain("Manage approval rules");
    expect(workspace).toContain("includeInactive=true");
    expect(workspace).toContain(
      "Pricing and invoice records remain read-only here",
    );
    expect(workspace).not.toContain("providerInvoiceId");
    expect(workspace).not.toContain("providerOrderId");
    expect(workspace).not.toContain("hostedPaymentUrl");
  });

  it("enforces local permissions, bounded inputs, revisions, and safe receipts", () => {
    expect(actions).toContain("hasTeamPermission(principal");
    expect(actions).toContain("values.length <= 250");
    expect(actions).toContain("isExactVersion(expectedVersion)");
    expect(actions).toContain("isIdempotencyKey(idempotencyKey)");
    expect(actions).toContain("readTeamMutationSuccess");
    expect(actions).toContain("unreadable success receipt");
  });
});
