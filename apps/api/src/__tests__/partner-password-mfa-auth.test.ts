import fs from "node:fs";
import path from "node:path";
import { partnerAuthRequestBindingsMatch } from "@/lib/partner-password-mfa-auth";
import {
  PARTNER_PASSWORD_MFA_MAX_ATTEMPTS,
  PARTNER_PASSWORD_MFA_TRANSACTION_TTL_MS,
  partnerPasswordLoginRequiresMfa,
} from "@/lib/partner-portal-auth";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner password-login MFA policy", () => {
  const baseline = {
    userMfaRequired: false,
    userMfaEnrolled: false,
    roleKey: "requester",
    roleCapabilities: [] as string[],
    capabilityGrants: [] as string[],
    capabilityDenies: [] as string[],
  };

  it("requires MFA for persisted enrollment, privileged roles, and sensitive capabilities", () => {
    expect(
      partnerPasswordLoginRequiresMfa({
        ...baseline,
        userMfaEnrolled: true,
      }),
    ).toBe(true);
    expect(
      partnerPasswordLoginRequiresMfa({
        ...baseline,
        roleKey: "administrator",
      }),
    ).toBe(true);
    expect(
      partnerPasswordLoginRequiresMfa({
        ...baseline,
        capabilityGrants: ["payments.*"],
      }),
    ).toBe(true);
    expect(
      partnerPasswordLoginRequiresMfa({
        ...baseline,
        capabilityGrants: ["commercial.edit"],
      }),
    ).toBe(true);
    expect(partnerPasswordLoginRequiresMfa(baseline)).toBe(false);
  });

  it("honors an explicit deny when evaluating a custom role capability", () => {
    expect(
      partnerPasswordLoginRequiresMfa({
        ...baseline,
        roleCapabilities: ["account.security.manage"],
        capabilityDenies: ["account.security.manage"],
      }),
    ).toBe(false);
  });

  it("binds both normalized IP and user agent", () => {
    const binding = {
      requestedIp: "203.0.113.7",
      requestedUserAgent: "Stonegate browser",
    };
    expect(partnerAuthRequestBindingsMatch(binding, { ...binding })).toBe(true);
    expect(
      partnerAuthRequestBindingsMatch(binding, {
        ...binding,
        requestedIp: "203.0.113.8",
      }),
    ).toBe(false);
    expect(
      partnerAuthRequestBindingsMatch(binding, {
        ...binding,
        requestedUserAgent: "Different browser",
      }),
    ).toBe(false);
  });

  it("keeps transactions short lived and attempts bounded", () => {
    expect(PARTNER_PASSWORD_MFA_TRANSACTION_TTL_MS).toBe(5 * 60 * 1_000);
    expect(PARTNER_PASSWORD_MFA_MAX_ATTEMPTS).toBe(8);
  });
});

describe("partner password-login MFA containment contract", () => {
  it("stores only a hashed, membership-bound one-use transaction", () => {
    const migration = source(
      "apps/api/src/db/migrations/0139_partner_password_mfa_transactions.sql",
    );
    expect(migration).toContain('CREATE TABLE "partner_auth_transactions"');
    expect(migration).toContain('"token_hash" varchar(43) NOT NULL');
    expect(migration).toContain(
      'CONSTRAINT "partner_auth_transactions_membership_binding_fk"',
    );
    expect(migration).toContain('"attempt_count" BETWEEN 0 AND 8');
    expect(migration).toContain('WHERE "consumed_at" IS NULL');
    expect(migration).not.toContain("transaction_token");
  });

  it("creates no partner session on the MFA-required password branch", () => {
    const auth = source("apps/api/src/lib/partner-portal-auth.ts");
    const branchStart = auth.indexOf("if (mfaRequired) {");
    const branchEnd = auth.indexOf(
      "const sessionToken = randomToken(32);",
      branchStart,
    );
    const branch = auth.slice(branchStart, branchEnd);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(branch).toContain("partnerAuthTransactions");
    expect(branch).not.toContain("insert(partnerSessions)");
  });

  it("consumes the transaction before atomically inserting an AAL2 session", () => {
    const completion = source("apps/api/src/lib/partner-password-mfa-auth.ts");
    const consume = completion.indexOf("const [consumedTransaction]");
    const session = completion.indexOf("insert(partnerSessions)", consume);
    expect(consume).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(consume);
    expect(completion).toContain('assuranceLevel: "aal2"');
    expect(completion).toContain("lastAcceptedCounter: method.lastTotpCounter");
    expect(completion).toContain("isNull(partnerMfaRecoveryCodes.usedAt)");
  });

  it("keeps the bearer in a secure server-only cookie and never in the MFA URL", () => {
    const actions = source("apps/site/src/app/partners/actions.ts");
    const page = source(
      "apps/site/src/app/partners/(public)/login/mfa/page.tsx",
    );
    expect(actions).toContain("name: PARTNER_AUTH_TRANSACTION_COOKIE");
    expect(actions).toContain("httpOnly: true");
    expect(actions).toContain("secure: true");
    expect(actions).toContain('sameSite: "lax"');
    expect(actions).toContain(
      'requestHeaders.set("Authorization", `Bearer ${transactionToken}`)',
    );
    expect(actions).not.toContain("token=${transactionToken}");
    expect(page).not.toContain('"use client"');
    expect(page).not.toContain('name="token"');
    expect(page).toContain('fetchCache = "force-no-store"');
  });
});
