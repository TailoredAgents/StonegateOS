import fs from "node:fs";
import path from "node:path";
import {
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  TEAM_PARTNER_LEGACY_PERMISSION_COMPATIBILITY,
  TEAM_PERMISSION_CATALOG,
} from "@myst-os/sdk";
import { normalizePartnerAccountDomain } from "@/lib/partner-account-domain-administration";
import {
  isTeamAuthenticationRecent,
  TeamMutationFailure,
} from "@/lib/team-mutation";

const ROOT = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("staff Partner administration mutation contract", () => {
  it("publishes narrow domain and migrated-membership permissions without delegating override", () => {
    expect(TEAM_PERMISSION_CATALOG).toEqual(
      expect.arrayContaining([
        "partners.domains.read",
        "partners.domains.manage",
        "partners.domains.verify",
        "partners.domains.revoke",
        "partners.memberships.migration.review",
      ]),
    );
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toContain(
      "partners.domains.override",
    );
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toContain(
      "partners.memberships.recover_admin",
    );
    expect(
      TEAM_PARTNER_LEGACY_PERMISSION_COMPATIBILITY["partners.invite"],
    ).toEqual(
      expect.arrayContaining([
        "partners.domains.verify",
        "partners.domains.revoke",
        "partners.memberships.migration.review",
      ]),
    );
    expect(
      TEAM_PARTNER_LEGACY_PERMISSION_COMPATIBILITY["partners.invite"],
    ).not.toContain("partners.domains.override");
  });

  it("requires a server-derived authentication ceremony within the policy window", () => {
    const now = Date.parse("2026-09-01T16:00:00.000Z");
    const actor = {
      type: "human" as const,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authMethod: "team_session" as const,
      authenticatedAt: "2026-09-01T15:50:00.000Z",
    };
    expect(isTeamAuthenticationRecent(actor, 15 * 60, now)).toBe(true);
    expect(
      isTeamAuthenticationRecent(
        { ...actor, authenticatedAt: "2026-09-01T15:44:59.000Z" },
        15 * 60,
        now,
      ),
    ).toBe(false);
    expect(
      isTeamAuthenticationRecent(
        { ...actor, authenticatedAt: null },
        15 * 60,
        now,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "app/api/admin/partner-management/v1/memberships/[membershipId]/role/route.ts",
      "partners.memberships.manage",
    ],
    [
      "app/api/admin/partner-management/v1/memberships/[membershipId]/scope/route.ts",
      "partners.memberships.manage",
    ],
    [
      "app/api/admin/partner-management/v1/memberships/[membershipId]/migration-review/route.ts",
      "partners.memberships.migration.review",
    ],
    [
      "app/api/admin/partner-management/v1/domains/[domainId]/verify/route.ts",
      "partners.domains.verify",
    ],
    [
      "app/api/admin/partner-management/v1/domains/[domainId]/revoke/route.ts",
      "partners.domains.revoke",
    ],
    [
      "app/api/admin/partner-management/v1/security/sessions/[sessionId]/revoke/route.ts",
      "partners.security.sessions.revoke",
    ],
    [
      "app/api/admin/partner-management/v1/security/identities/[userId]/disable/route.ts",
      "partners.identities.disable",
    ],
    [
      "app/api/admin/partner-management/v1/quarantine/[caseId]/resolve/route.ts",
      "partners.quarantine.release",
    ],
  ])(
    "protects %s with recent auth and idempotent destructive policy",
    (file, permission) => {
      const route = source(file);
      expect(route).toContain("beginTeamMutation(request");
      expect(route).toContain(`requiredPermissions: ["${permission}"]`);
      expect(route).toContain('risk: "destructive"');
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    },
  );

  it("keeps role and scope mutations inside the canonical member domain", () => {
    const helper = source(
      "src/lib/partner-management-member-mutation-route.ts",
    );
    const service = source("src/lib/partner-portal-v2-members.ts");
    expect(helper).toContain("mutatePartnerAccountMemberAsStaff");
    expect(helper).toContain("claimTeamMutationIdempotency");
    expect(helper).toContain("mutation.audit.insertSuccess");
    expect(service).toContain("createPartnerMemberTargetCondition(");
    expect(service).toContain("activeAdministratorCount(rows) <= 1");
    expect(service).toContain("partnerMembershipLocationScopes");
    expect(service).toContain("partnerMembershipCostCenterScopes");
  });

  it("reviews migrated privilege under account lock and removes only migration protections", () => {
    const route = source(
      "app/api/admin/partner-management/v1/memberships/[membershipId]/migration-review/route.ts",
    );
    const service = source("src/lib/partner-portal-v2-members.ts");
    expect(route).toContain("partners.memberships.recover_admin");
    expect(route).toContain("strengthenTeamMutationPolicy");
    expect(route).toContain("reviewMigratedPartnerAccountMemberAsStaff");
    expect(service).toContain("MIGRATED_PARTNER_ROLE_PROTECTIVE_DENIES");
    expect(service).toContain('target.migrationReviewStatus !== "pending"');
    expect(service).toContain("The final active administrator is protected.");
    expect(service).toContain("partnerSessions.activePartnerAccountId");
  });

  it("prevents direct membership reactivation from bypassing quarantine", () => {
    const route = source(
      "app/api/admin/partner-management/v1/memberships/[membershipId]/route.ts",
    );
    expect(route).toContain('target.migrationReviewStatus === "quarantined"');
    expect(route).toContain("Quarantined access cannot be reactivated.");
    expect(route).toContain(
      'identityStatuses.get(target.partnerUserId) !== "active"',
    );
  });

  it("revokes exactly one partner session without changing identity or membership lifecycle", () => {
    const route = source(
      "app/api/admin/partner-management/v1/security/sessions/[sessionId]/revoke/route.ts",
    );
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(route).toContain('scope: "single_partner_session"');
    expect(route).toContain("identityStateChanged: false");
    expect(route).toContain("membershipStateChanged: false");
    expect(route).toContain("partnerSessions.revokedAt");
    expect(route).not.toContain(".update(partnerUsers)");
    expect(route).not.toContain(".update(partnerAccountMemberships)");
    expect(route).not.toContain("sessionHash:");
  });

  it("limits quarantine resolution to the schema-backed provider-evidence lifecycle", () => {
    const route = source(
      "app/api/admin/partner-management/v1/quarantine/[caseId]/resolve/route.ts",
    );
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toContain(
      "partners.quarantine.release",
    );
    expect(route).toContain(
      'requiredPermissions: ["partners.quarantine.release"]',
    );
    expect(route).toContain("partnerQuarantineCaseId");
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(route).toContain("hasAcceptedPartnerInviteProviderEvidence");
    expect(route).toContain("automaticRedispatchAttempted: false");
    expect(route).toContain("providerCalled: false");
    expect(route).toContain(".update(partnerInviteOperations)");
    expect(route).toContain("resolutionEvidence: parsed.data.reason");
    expect(route).toContain("partnerLoginTokens.usedAt");
    expect(route).not.toContain(".update(partnerUsers)");
    expect(route).not.toContain(".update(partnerAccountMemberships)");
    expect(route).not.toContain("sendEmail");
    expect(route).not.toContain("sendSms");
  });

  it("serializes verified-domain authority and never exposes stored evidence in the directory", () => {
    const service = source("src/lib/partner-account-domain-administration.ts");
    const directory = source("src/lib/partner-management-directory.ts");
    const lifecycle = source(
      "src/lib/partner-account-domain-mutation-route.ts",
    );
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("allowConflictingVerificationOverride");
    expect(service).toContain("ne(partnerAccountDomains.partnerAccountId");
    expect(lifecycle).toContain("partners.domains.override");
    expect(lifecycle).toContain("strengthenTeamMutationPolicy");
    expect(directory).toContain("verificationEvidencePresent");
    expect(directory).not.toContain(
      "verificationEvidence: partnerAccountDomains.verificationEvidence",
    );
  });

  it("normalizes IDNs and rejects URLs and consumer mailbox boundaries", () => {
    expect(normalizePartnerAccountDomain("  EXAMPLE.COM. ")).toBe(
      "example.com",
    );
    expect(normalizePartnerAccountDomain("bücher.example")).toBe(
      "xn--bcher-kva.example",
    );
    for (const domain of [
      "https://example.com",
      "admin@example.com",
      "example.com/path",
      "gmail.com",
    ]) {
      expect(() => normalizePartnerAccountDomain(domain)).toThrow(
        TeamMutationFailure,
      );
    }
  });
});
