import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("partner verification-first authentication contracts", () => {
  it("ships a replay-safe purpose-bound credential schema", () => {
    const migration = source(
      "src/db/migrations/0131_partner_verification_first_auth.sql",
    );
    expect(migration).toContain('CREATE TABLE "partner_auth_challenges"');
    expect(migration).toContain('CREATE TABLE "partner_applicant_sessions"');
    expect(migration).toContain("'email_verification'");
    expect(migration).toContain("'account_activation'");
    expect(migration).toContain("'password_reset'");
    expect(migration).toContain('UPDATE "partner_notification_preferences"');
    expect(
      migration.match(/"company_resolution_choice" = 'join_existing'/gu),
    ).toHaveLength(1);
  });

  it("scopes concurrent activation credentials to an account membership", () => {
    const migration = source(
      "src/db/migrations/0135_partner_activation_membership_scope.sql",
    );
    const service = source("src/lib/partner-purpose-auth.ts");
    expect(migration).toContain(
      'DROP INDEX IF EXISTS "partner_auth_challenges_active_purpose_email_key"',
    );
    expect(migration).toContain(
      '"partner_auth_challenges_active_activation_membership_key"',
    );
    expect(migration).toContain(
      '"purpose", "partner_account_id", "partner_membership_id"',
    );
    expect(service).toContain("membership:${activationMembershipId}");
    expect(service).toMatch(
      /eq\(\s*partnerAuthChallenges\.partnerMembershipId/gu,
    );
    expect(migration).not.toMatch(
      /"purpose" = 'account_activation'[\s\S]{0,300}"application_id" IS NOT NULL/gu,
    );
  });

  it("keeps the legacy application endpoint as a verification-first alias", () => {
    const route = source("app/api/portal/v2/access-applications/route.ts");
    expect(route).toContain("submitVerifiedPartnerApplication");
    expect(route).not.toContain("bootstrapPartnerAccessApplication");
    expect(route).not.toContain("requestLegacyPartnerLoginLink");
  });

  it("matches companies only through verified canonical account domains", () => {
    const onboarding = source("src/lib/partner-verification-onboarding.ts");
    expect(onboarding).toContain("partnerAccountDomains");
    expect(onboarding).toContain(
      'eq(partnerAccountDomains.status, "verified")',
    );
    expect(onboarding).toContain('state: "reconciliation_required"');
    expect(onboarding).not.toContain("partnerAccounts.domain");
  });

  it("provisions a tenant only in the staff approval transaction", () => {
    const submit = source(
      "app/api/portal/v2/onboarding/application/submit/route.ts",
    );
    const approval = source(
      "app/api/admin/partners/access-applications/[applicationId]/route.ts",
    );
    expect(submit).not.toContain(
      "provisionVerificationFirstPartnerApplication",
    );
    expect(approval).toContain("provisionVerificationFirstPartnerApplication");
    expect(approval).toContain("application.flowVersion === 2");
    expect(approval).toContain("roleKey: decision.roleKey");
    expect(approval).toContain("accessLevel: decision.accessLevel");
    expect(approval).toContain(
      'application.companyResolutionChoice !== "join_existing"',
    );
    const administration = source(
      "src/lib/partner-access-application-administration.ts",
    );
    expect(administration).toContain("row.flowVersion === 2 || tenantBound");
    expect(administration).toContain(
      "row.flowVersion !== 2 && !tenantBound",
    );
  });

  it("removes phone delivery and gates every routine magic-link adapter", () => {
    for (const path of [
      "app/api/public/partners/request-link/route.ts",
      "app/api/public/partners/exchange/route.ts",
      "app/api/portal/v2/auth/magic-link/request/route.ts",
      "app/api/portal/v2/auth/magic-link/consume/route.ts",
    ]) {
      expect(source(path)).toContain("isPartnerRoutineMagicLinkLoginEnabled");
    }
    const requestLink = source("app/api/public/partners/request-link/route.ts");
    expect(requestLink).not.toContain("findActivePartnerUserByPhone");
    expect(requestLink).not.toContain('requestedChannels: ["email", "sms"]');
  });

  it("uses versioned Argon2id and limits privileged activation to security setup", () => {
    const crypto = source("src/lib/partner-password-crypto.ts");
    const auth = source("src/lib/partner-portal-auth.ts");
    const passwordManagement = source("src/lib/partner-password-management.ts");
    const activation = source(
      "app/api/portal/v2/onboarding/activation/complete/route.ts",
    );
    expect(crypto).toContain("PARTNER_PASSWORD_HASH_VERSION_ARGON2ID = 2");
    expect(crypto).toContain("verifyLegacyScrypt");
    expect(auth).toContain("verification.needsRehash");
    expect(passwordManagement).toContain(
      "export const PARTNER_PASSWORD_MIN_LENGTH = 15",
    );
    expect(passwordManagement).not.toContain(
      'input.authMethod === "magic_link"',
    );
    expect(activation).toContain('"mfa_setup_required"');
    expect(activation).toContain('"pre_authentication_only"');
  });
});
