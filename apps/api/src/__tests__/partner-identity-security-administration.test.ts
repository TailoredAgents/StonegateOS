import fs from "node:fs";
import path from "node:path";
import { TEAM_OWNER_ONLY_PERMISSION_CATALOG } from "@myst-os/sdk";
import { partnerActivationStateKind } from "@/lib/partner-purpose-auth";
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

  it("allows active-membership activation only for the exact MFA recovery state", () => {
    const recovery = {
      user: {
        active: true,
        identityStatus: "active",
        mfaRequired: true,
        mfaEnrolledAt: null,
        passwordHash: "$argon2id$test",
      },
      membershipStatus: "active",
      hasEnabledMfaMethod: false,
    } as const;
    expect(partnerActivationStateKind(recovery)).toBe("mfa_recovery");
    expect(
      partnerActivationStateKind({
        ...recovery,
        hasEnabledMfaMethod: true,
      }),
    ).toBeNull();
    expect(
      partnerActivationStateKind({
        ...recovery,
        user: { ...recovery.user, passwordHash: null },
      }),
    ).toBeNull();
    expect(
      partnerActivationStateKind({
        ...recovery,
        user: { ...recovery.user, mfaRequired: false },
      }),
    ).toBeNull();
    expect(
      partnerActivationStateKind({
        ...recovery,
        membershipStatus: "suspended",
      }),
    ).toBeNull();
  });

  it("keeps both global actions non-delegable and behind recent Team MFA", () => {
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toEqual(
      expect.arrayContaining([
        "partners.identities.disable",
        "partners.security.mfa.reset",
      ]),
    );
    for (const [relativePath, permission] of [
      [
        "apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/disable/route.ts",
        "partners.identities.disable",
      ],
      [
        "apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/mfa/reset/route.ts",
        "partners.security.mfa.reset",
      ],
    ] as const) {
      const route = source(relativePath);
      expect(route).toContain('principalTypes: ["human"]');
      expect(route).toContain(`requiredPermissions: ["${permission}"]`);
      expect(route).toContain('risk: "destructive"');
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    }
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
    const resetStart = service.indexOf(
      "export async function resetPartnerMfaAsTeamOwner",
    );
    const disable = service.slice(disableStart, resetStart);
    expect(disable).toContain(".update(partnerUsers)");
    expect(disable).toContain('identityStatus: "disabled"');
    expect(disable).toContain("securityVersion: nextSecurityVersion");
    expect(service).toContain(".update(partnerSessions)");
    expect(service).toContain(".update(partnerLoginTokens)");
    expect(service).toContain(".update(partnerAuthTransactions)");
    expect(service).toContain(".update(partnerAuthChallenges)");
    expect(disable).not.toContain(".update(partnerAccountMemberships)");
    expect(disable).not.toContain(".delete(partnerAccountMemberships)");
    expect(disable).not.toContain("partnerBookings");
    expect(disable).not.toContain("partnerInvoices");
    expect(disable).toContain("recordsPreserved: true");
    expect(disable).toContain("membershipsChanged: false");
  });

  it("revokes MFA material and creates only a purpose-bound recovery challenge", () => {
    const service = source(
      "apps/api/src/lib/partner-identity-security-administration.ts",
    );
    const activation = source("apps/api/src/lib/partner-purpose-auth.ts");
    const activationMfa = source(
      "apps/api/src/lib/partner-activation-mfa-auth.ts",
    );
    const routeHelper = source(
      "apps/api/src/lib/partner-identity-security-mutation-route.ts",
    );
    expect(service).toContain("credentialIdHash: null");
    expect(service).toContain("credentialReference: null");
    expect(service).toContain("totpSecretCiphertext: null");
    expect(service).toContain("totpSecretKeyVersion: null");
    expect(service).toContain(".update(partnerMfaRecoveryCodes)");
    expect(service).toContain(".delete(partnerMfaEnrollmentChallenges)");
    expect(service).toContain("createPartnerActivationChallengeInTransaction");
    expect(service).toContain('recoveryDelivery: "queued"');
    expect(routeHelper).not.toContain("rawToken");
    expect(activation).toContain('return "mfa_recovery"');
    expect(activation).toContain("existingPasswordVerification");
    expect(activationMfa).toContain("context.recovery");
    expect(activationMfa).toContain("membershipActivated: !context.recovery");
    expect(activationMfa).toContain('assuranceLevel: "aal2"');
  });

  it("presents high-friction owner controls with the full membership impact", () => {
    const workspace = source(
      "apps/site/src/app/team/components/PartnerAdministrationSection.tsx",
    );
    const actions = source(
      "apps/site/src/app/team/actions/partner-administration.ts",
    );
    const manifest = source("apps/site/src/app/team/action-policy-manifest.ts");
    expect(workspace).toContain("Review every affected company membership");
    expect(workspace).toContain("DISABLE ${identity.email}");
    expect(workspace).toContain("RESET ${identity.email} MFA");
    expect(workspace).toContain(
      "account, job, document, payment, and financial",
    );
    expect(workspace).toContain("partnerIdentityDisableAction");
    expect(workspace).toContain("partnerMfaResetAction");
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.identities.disable")',
    );
    expect(actions).toContain(
      'hasTeamPermission(principal, "partners.security.mfa.reset")',
    );
    expect(manifest).toContain(
      "partnerIdentityDisableAction: recentHumanAction",
    );
    expect(manifest).toContain("partnerMfaResetAction: recentHumanAction");
  });
});
