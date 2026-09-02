import fs from "node:fs";
import path from "node:path";
import { partnerActivationMfaContextIsEligible } from "@/lib/partner-activation-mfa-auth";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("privileged partner activation eligibility", () => {
  const baseline = {
    user: {
      active: false,
      identityStatus: "pending_activation" as const,
      securityVersion: 3,
    },
    transaction: {
      securityVersion: 3,
      requestedIp: "203.0.113.17",
      requestedUserAgent: "Stonegate browser",
    },
    currentBinding: {
      requestedIp: "203.0.113.17",
      requestedUserAgent: "Stonegate browser",
    },
  };

  it("accepts only the pending-inactive or active-active identity states", () => {
    expect(partnerActivationMfaContextIsEligible(baseline)).toBe(true);
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        user: { ...baseline.user, active: true },
      }),
    ).toBe(false);
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        user: {
          ...baseline.user,
          active: true,
          identityStatus: "active",
        },
      }),
    ).toBe(true);
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        user: {
          ...baseline.user,
          active: false,
          identityStatus: "suspended",
        },
      }),
    ).toBe(false);
  });

  it("fails closed on security-version, IP, or user-agent drift", () => {
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        transaction: { ...baseline.transaction, securityVersion: 2 },
      }),
    ).toBe(false);
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        currentBinding: {
          ...baseline.currentBinding,
          requestedIp: "203.0.113.18",
        },
      }),
    ).toBe(false);
    expect(
      partnerActivationMfaContextIsEligible({
        ...baseline,
        currentBinding: {
          ...baseline.currentBinding,
          requestedUserAgent: "Different browser",
        },
      }),
    ).toBe(false);
  });
});

describe("privileged activation containment contract", () => {
  it("binds setup and bootstrap state to the exact source challenge and membership", () => {
    const migration = source(
      "apps/api/src/db/migrations/0141_partner_activation_mfa_gate.sql",
    );
    expect(migration).toContain("'activation_mfa_setup'");
    expect(migration).toContain('"source_auth_challenge_id"');
    expect(migration).toContain('"auth_transaction_id"');
    expect(migration).toContain(
      'REFERENCES "partner_auth_transactions"("id") ON DELETE CASCADE',
    );
    expect(migration).toContain(
      '"purpose" = \'activation_mfa_setup\' AND "source_auth_challenge_id" IS NOT NULL',
    );
  });

  it("creates no portal session and leaves membership activation for MFA confirmation", () => {
    const activation = source("apps/api/src/lib/partner-purpose-auth.ts");
    const branchStart = activation.indexOf("if (mfaGateRequired) {");
    const branchEnd = activation.indexOf(
      "const sessionToken = randomBytes(32)",
      branchStart,
    );
    const branch = activation.slice(branchStart, branchEnd);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(branch).toContain('purpose: "activation_mfa_setup"');
    expect(branch).toContain(
      'membershipStillInvited: row.membership.status === "invited"',
    );
    expect(branch).not.toContain("insert(partnerSessions)");
    expect(branch).not.toContain('status: "active", acceptedAt: now');
  });

  it("consumes one-use pre-auth before activating and issuing an AAL2 session", () => {
    const completion = source(
      "apps/api/src/lib/partner-activation-mfa-auth.ts",
    );
    const consume = completion.indexOf("const [consumedTransaction]");
    const userActivation = completion.indexOf("const [userActivated]", consume);
    const membershipActivation = completion.indexOf(
      "const [membershipActivated]",
      userActivation,
    );
    const session = completion.indexOf(
      "insert(partnerSessions)",
      membershipActivation,
    );
    expect(consume).toBeGreaterThan(-1);
    expect(userActivation).toBeGreaterThan(consume);
    expect(membershipActivation).toBeGreaterThan(userActivation);
    expect(session).toBeGreaterThan(membershipActivation);
    expect(completion).toContain('assuranceLevel: "aal2"');
    expect(completion).toContain(
      "lastAcceptedCounter: activeMethod.lastTotpCounter",
    );
    expect(completion).toContain("isNull(partnerMfaRecoveryCodes.usedAt)");
  });

  it("keeps the setup bearer in a secure server cookie and off URLs/client props", () => {
    const proxy = source(
      "apps/site/src/app/api/partners/onboarding/[...segments]/route.ts",
    );
    const page = source(
      "apps/site/src/app/partners/(public)/activate/mfa/page.tsx",
    );
    expect(proxy).toContain("name: PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE");
    expect(proxy).toContain("httpOnly: true");
    expect(proxy).toContain("secure: true");
    expect(proxy).toContain('sameSite: "lax"');
    expect(proxy).toContain(
      'headers.set("Authorization", `Bearer ${transactionToken}`)',
    );
    expect(proxy).not.toContain("token=${transactionToken}");
    expect(page).not.toContain('"use client"');
    expect(page).not.toContain('name="token"');
    expect(page).toContain('fetchCache = "force-no-store"');
  });
});
