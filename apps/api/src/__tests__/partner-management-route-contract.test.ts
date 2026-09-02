import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());

describe("staff partner management route contract", () => {
  it.each([
    ["accounts", "partners.accounts.read"],
    ["applications", "partners.applications.read"],
    ["commercial", "partners.commercial.read"],
    ["people", "partners.people.read"],
    ["memberships", "partners.memberships.read"],
    ["invitations", "partners.invitations.read"],
    ["domains", "partners.domains.read"],
    ["join-requests", "partners.joins.read"],
    ["quarantine", "partners.quarantine.read"],
    ["security", "partners.security.read"],
  ])(
    "protects %s with its granular read permission",
    (resource, permission) => {
      const route = fs.readFileSync(
        path.join(
          ROOT,
          "app/api/admin/partner-management/v1",
          resource,
          "route.ts",
        ),
        "utf8",
      );
      expect(route).toContain(`"${resource}"`);
      expect(route).toContain(`"${permission}"`);
      expect(route).toContain("partnerManagementListResponse");
    },
  );

  it("makes the Partner workspace top-level and keeps legacy CRM tools explicit", () => {
    const registry = fs.readFileSync(
      path.resolve(ROOT, "../site/src/app/team/surface-registry.ts"),
      "utf8",
    );
    const workspace = fs.readFileSync(
      path.resolve(
        ROOT,
        "../site/src/app/team/components/PartnerAdministrationSection.tsx",
      ),
      "utf8",
    );
    expect(registry).toContain('canonicalPath: "/team/partners"');
    expect(registry).toContain('"partners.accounts.read"');
    expect(registry).toContain('"partners.applications.read"');
    expect(registry).toContain('"partners.commercial.read"');
    expect(registry).toContain('"partners.domains.read"');
    expect(registry).toContain('"partners.memberships.read"');
    expect(registry).toContain('"partners.security.read"');
    expect(registry).toContain('"partners.quarantine.read"');
    expect(workspace).toContain('id: "relationships"');
    expect(workspace).toMatch(/Global\s+identity disable is an owner-only/u);
  });

  it("gates legacy global identity lifecycle with the owner-only permission", () => {
    const route = fs.readFileSync(
      path.join(ROOT, "app/api/admin/partners/users/route.ts"),
      "utf8",
    );
    const patchHandler = route.slice(
      route.indexOf("export async function PATCH"),
      route.indexOf("export async function POST"),
    );
    expect(patchHandler).toContain(
      'requiredPermissions: ["partners.identities.disable"]',
    );
    expect(patchHandler).not.toContain(
      'requiredPermissions: ["partners.invite"]',
    );
  });

  it("makes account-scoped suspension audited, idempotent, and final-admin safe", () => {
    const route = fs.readFileSync(
      path.join(
        ROOT,
        "app/api/admin/partner-management/v1/memberships/[membershipId]/route.ts",
      ),
      "utf8",
    );
    expect(route).toContain(
      'requiredPermissions: ["partners.memberships.suspend"]',
    );
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(route).toContain("activeAdministrators <= 1");
    expect(route).toContain("partnerSessions.activePartnerAccountId");
    expect(route).toContain('scope: "single_partner_account"');
  });

  it("lists safe session posture without exposing session credentials or network fingerprints", () => {
    const directory = fs.readFileSync(
      path.join(ROOT, "src/lib/partner-management-directory.ts"),
      "utf8",
    );
    const securityList = directory.slice(
      directory.indexOf("async function listSecuritySessions"),
      directory.indexOf("async function listDomains"),
    );
    expect(securityList).toContain("partnerSessions.activePartnerAccountId");
    expect(securityList).toContain("partnerSessions.activeMembershipId");
    expect(securityList).toContain(
      "partnerAccountMemberships.partnerAccountId",
    );
    expect(securityList).toContain("partnerAccountMemberships.partnerUserId");
    expect(securityList).toContain("partnerSessions.lastSeenAt");
    expect(securityList).not.toContain("partnerSessions.sessionHash");
    expect(securityList).not.toContain("partnerSessions.ip");
    expect(securityList).not.toContain("partnerSessions.userAgent");
    expect(securityList).not.toContain("partnerSessions.securityVersion");
  });

  it("normalizes heterogeneous quarantine records without exposing provider payloads or credentials", () => {
    const directory = fs.readFileSync(
      path.join(ROOT, "src/lib/partner-management-directory.ts"),
      "utf8",
    );
    const quarantine = directory.slice(
      directory.indexOf("async function listQuarantineCases"),
      directory.indexOf("async function listDomains"),
    );
    expect(quarantine).toContain('caseKind: "identity"');
    expect(quarantine).toContain('caseKind: "membership_migration"');
    expect(quarantine).toContain('caseKind: "invite_delivery"');
    expect(quarantine).toContain("resolutionAvailable");
    expect(quarantine).toContain("providerOperationIds");
    expect(quarantine).not.toContain("sessionHash");
    expect(quarantine).not.toContain("tokenHash");
    expect(quarantine).not.toContain("idempotencyKeyHash");
    expect(quarantine).not.toContain("providerRequestKey");
    expect(quarantine).not.toContain("failureDetail:");
  });

  it("summarizes account commercial readiness without exposing provider or internal economics", () => {
    const directory = fs.readFileSync(
      path.join(ROOT, "src/lib/partner-management-directory.ts"),
      "utf8",
    );
    const commercial = directory.slice(
      directory.indexOf("async function listCommercialReadiness"),
      directory.indexOf("async function listPeople"),
    );
    expect(commercial).toContain("partnerRateCards.partnerAccountId");
    expect(commercial).toContain("partnerApprovalRules.partnerAccountId");
    expect(commercial).toContain("partnerInvoices.partnerAccountId");
    expect(commercial).toContain("partnerPaymentAllocations.partnerAccountId");
    expect(commercial).toContain('billingConfigurationState: "not_modeled"');
    expect(commercial).toContain("providerWriteAvailable: false");
    expect(commercial).not.toContain("providerInvoiceId");
    expect(commercial).not.toContain("providerOrderId");
    expect(commercial).not.toContain("hostedPaymentUrl:");
    expect(commercial).not.toContain("margin");
    expect(commercial).not.toContain("commission");
  });
});
