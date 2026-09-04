import fs from "node:fs";
import path from "node:path";
import { TEAM_OWNER_ONLY_PERMISSION_CATALOG } from "@myst-os/sdk";
import { partnerIdentityMembershipSnapshot } from "@/lib/partner-identity-security-administration";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const MEMBERSHIPS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    partnerAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountName: "Alpha Property Group",
    accountStatus: "portal_partner",
    portalAccessEnabled: true,
    roleKey: "administrator",
    status: "active",
    isDefault: true,
    version: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    partnerAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    accountName: "Beta Construction",
    accountStatus: "managed_partner",
    portalAccessEnabled: true,
    roleKey: "viewer",
    status: "suspended",
    isDefault: false,
    version: "2026-09-01T12:01:00.000Z",
  },
] as const;

describe("Team Owner partner identity security", () => {
  it("binds confirmation to a stable, order-independent membership snapshot", () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const first = partnerIdentityMembershipSnapshot(userId, MEMBERSHIPS);
    const reordered = partnerIdentityMembershipSnapshot(userId, [
      MEMBERSHIPS[1],
      MEMBERSHIPS[0],
    ]);
    const changed = partnerIdentityMembershipSnapshot(userId, [
      MEMBERSHIPS[0],
      { ...MEMBERSHIPS[1], status: "active" },
    ]);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("keeps global identity disable non-delegable and behind recent Team authentication", () => {
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toContain(
      "partners.identities.disable",
    );
    const route = source(
      "apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/disable/route.ts",
    );
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain(
      'requiredPermissions: ["partners.identities.disable"]',
    );
    expect(route).toContain('risk: "destructive"');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
  });

  it("enumerates and version-binds every membership before a global mutation", () => {
    const service = source(
      "apps/api/src/lib/partner-identity-security-administration.ts",
    );
    const impactRoute = source(
      "apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/route.ts",
    );
    expect(impactRoute).toContain('"partners.identities.disable"');
    expect(impactRoute).toContain("getPartnerIdentitySecurityImpact");
    expect(service).toContain(
      "PARTNER_IDENTITY_SECURITY_MAX_MEMBERSHIPS = 250",
    );
    expect(service).toContain(
      "LOCK TABLE partner_account_memberships IN SHARE MODE",
    );
    expect(service).toContain("partnerIdentityMembershipSnapshot(");
    expect(service).toContain(
      "impact.membershipSnapshot !== input.membershipSnapshot",
    );
    expect(service).toContain("assertTeamMutationExpectedVersion(");
    expect(service).toContain("allMembershipsEnumerated");
  });

  it("globally disables only the identity and credentials while preserving account records", () => {
    const service = source(
      "apps/api/src/lib/partner-identity-security-administration.ts",
    );
    const disableStart = service.indexOf(
      "export async function disablePartnerIdentityAsTeamOwner",
    );
    const disable = service.slice(disableStart);
    expect(disable).toContain(".update(partnerUsers)");
    expect(disable).toContain('identityStatus: "disabled"');
    expect(disable).toContain("securityVersion: nextSecurityVersion");
    expect(service).toContain(".update(partnerSessions)");
    expect(service).toContain(".update(partnerLoginTokens)");
    expect(service).toContain(".update(partnerAuthChallenges)");
    expect(disable).not.toContain(".update(partnerAccountMemberships)");
    expect(disable).not.toContain(".delete(partnerAccountMemberships)");
    expect(disable).not.toContain("partnerBookings");
    expect(disable).not.toContain("partnerInvoices");
    expect(disable).toContain("recordsPreserved: true");
    expect(disable).toContain("membershipsChanged: false");
  });

  it("presents the high-friction identity-disable control with full membership impact", () => {
    const workspace = source(
      "apps/site/src/app/team/components/PartnerAdministrationSection.tsx",
    );
    const actions = source(
      "apps/site/src/app/team/actions/partner-administration.ts",
    );
    const manifest = source("apps/site/src/app/team/action-policy-manifest.ts");
    expect(workspace).toContain("Review every affected company membership");
    expect(workspace).toContain("DISABLE ${identity.email}");
    expect(workspace).toContain(
      "account, job, document, payment, and financial",
    );
    expect(workspace).toContain("partnerIdentityDisableAction");
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.identities.disable")',
    );
    expect(manifest).toContain(
      "partnerIdentityDisableAction: recentHumanAction",
    );
  });
});
