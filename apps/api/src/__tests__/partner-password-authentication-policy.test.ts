import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner password-only authentication policy", () => {
  it("creates password sessions without an MFA transaction branch", () => {
    const auth = source("apps/api/src/lib/partner-portal-auth.ts");
    expect(auth).not.toContain("if (mfaRequired) {");
    expect(auth).not.toContain("insert(partnerAuthTransactions)");
    expect(auth).toContain("insert(partnerSessions)");
  });

  it("has no live partner MFA completion or enrollment API handlers", () => {
    const retiredHandlers = [
      "apps/api/app/api/public/partners/login-password/mfa/route.ts",
      "apps/api/app/api/portal/v2/mfa/route.ts",
      "apps/api/app/api/portal/v2/mfa/step-up/route.ts",
      "apps/api/app/api/portal/v2/mfa/totp/enrollment/route.ts",
      "apps/api/app/api/portal/v2/mfa/totp/enrollment/[challengeId]/confirm/route.ts",
      "apps/api/app/api/portal/v2/onboarding/activation/mfa/enrollment/route.ts",
      "apps/api/app/api/portal/v2/onboarding/activation/mfa/confirm/route.ts",
    ];
    for (const handler of retiredHandlers) {
      expect(fs.existsSync(path.join(ROOT, handler))).toBe(false);
    }
  });

  it("recovers only eligible identities stranded in the retired activation handoff", () => {
    const auth = source("apps/api/src/lib/partner-portal-auth.ts");
    const recovery = auth.slice(
      auth.indexOf("async function recoverRetiredActivationHandoff"),
      auth.indexOf("function readString"),
    );
    expect(auth).toContain("recoverRetiredActivationHandoff");
    expect(recovery).toContain(
      'eq(partnerAuthTransactions.purpose, "activation_mfa_setup")',
    );
    expect(recovery).toContain(
      'inArray(partnerAccountMemberships.status, ["invited", "active"])',
    );
    expect(recovery).toContain(
      "inArray(partnerAccountMemberships.migrationReviewStatus, [",
    );
    expect(recovery).toContain('"not_required"');
    expect(recovery).toContain('"approved"');
    expect(recovery).toContain("eq(partnerAccounts.portalAccessEnabled, true)");
    expect(recovery).toContain(
      'eq(partnerAccounts.portalLifecycleStatus, "active")',
    );
    expect(recovery).toContain("if (!binding) return alreadyActive");
    expect(auth).toContain("if (!identityIsActive) return null");
    expect(recovery).not.toContain('"pending"');
    expect(recovery).not.toContain('"quarantined"');
  });

  it("retires legacy sessions and limits dormant magic-link sessions", () => {
    const auth = source("apps/api/src/lib/partner-portal-auth.ts");
    expect(auth).toContain("activePartnerSessionAuthMethod");
    expect(auth).toContain('error: "session_revoked"');
    const sessionPolicy = source(
      "apps/api/src/lib/partner-session-auth-policy.ts",
    );
    expect(sessionPolicy).toContain('"legacy"');
    expect(sessionPolicy).toContain('"mfa_step_up"');
    expect(sessionPolicy).toContain('methods.push("magic_link")');
    expect(sessionPolicy).toContain("!isPartnerRoutineMagicLinkLoginEnabled()");
    const authorization = source(
      "apps/api/src/lib/partner-account-authorization.ts",
    );
    expect(authorization).toContain("ROUTINE_MAGIC_LINK_CAPABILITIES");
    expect(authorization).toContain('"portal.session.read"');
    expect(authorization).toContain(
      'authentication.session.authMethod === "magic_link"',
    );
    expect(authorization).toContain('request.method !== "GET"');
    expect(authorization).toContain('request.method !== "HEAD"');
    const switchRoute = source(
      "apps/api/app/api/portal/v2/session/account/route.ts",
    );
    expect(switchRoute).toContain(
      'authentication.session.authMethod === "magic_link"',
    );
    expect(switchRoute).toContain('"forbidden"');
    const passwordLogin = auth.slice(
      auth.indexOf("export async function loginWithPassword"),
    );
    expect(passwordLogin).toContain("update(partnerAuthTransactions)");
    expect(passwordLogin).toContain("update(partnerLoginTokens)");
    expect(passwordLogin).toContain("update(partnerSessions)");
    expect(passwordLogin).toContain('"mfa_step_up"');
    expect(passwordLogin).toContain(
      "eq(partnerAuthTransactions.partnerUserId, userRow.id)",
    );
    expect(passwordLogin).toContain(
      "eq(partnerLoginTokens.partnerUserId, userRow.id)",
    );
    for (const inventory of [
      source("apps/api/src/lib/partner-portal-session-management.ts"),
      source("apps/api/src/lib/partner-management-directory.ts"),
    ]) {
      expect(inventory).toContain("isRetiredPartnerSessionAuthMethod");
      expect(inventory).toContain("publicPartnerSessionAuthMethod");
      expect(inventory).not.toContain('=== "mfa_step_up" ? "password"');
    }
  });

  it("keeps legacy partner MFA pages as non-interactive redirects", () => {
    const actions = source("apps/site/src/app/partners/actions.ts");
    const loginPage = source(
      "apps/site/src/app/partners/(public)/login/mfa/page.tsx",
    );
    const activationPage = source(
      "apps/site/src/app/partners/(public)/activate/mfa/page.tsx",
    );
    expect(actions).not.toContain("PARTNER_AUTH_TRANSACTION_COOKIE");
    expect(actions).not.toContain("token=${transactionToken}");
    for (const page of [loginPage, activationPage]) {
      expect(page).not.toContain('"use client"');
      expect(page).not.toContain('name="token"');
      expect(page).not.toContain("fetch(");
      expect(page).toContain("redirect(");
      expect(page).toContain('fetchCache = "force-no-store"');
    }
  });

  it("keeps retired security flags inert instead of rewriting existing identities", () => {
    for (const path of [
      "apps/api/src/lib/partner-account-invitations.ts",
      "apps/api/src/lib/partner-verification-onboarding.ts",
      "apps/api/src/lib/partner-purpose-auth.ts",
      "apps/api/src/lib/partner-account-lifecycle-administration.ts",
      "apps/api/src/lib/partner-portal-auth.ts",
      "apps/api/app/api/admin/partners/access-applications/[applicationId]/route.ts",
    ]) {
      const implementation = source(path);
      const identityUpdateBlocks = [
        ...implementation.matchAll(
          /\.update\(partnerUsers\)([\s\S]*?)\.where\(/gu,
        ),
      ].map((match) => match[1] ?? "");
      for (const updateBlock of identityUpdateBlocks) {
        expect(updateBlock).not.toContain("mfaRequired");
        expect(updateBlock).not.toContain("mfaEnrolledAt");
      }
    }
  });
});
