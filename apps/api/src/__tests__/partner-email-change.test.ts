import fs from "node:fs";
import path from "node:path";
import { isRecentPartnerEmailChangeAuthentication } from "@/lib/partner-email-change";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("Partner email-change assurance", () => {
  const now = new Date("2035-09-01T16:00:00.000Z");

  it("accepts only a recent password-authenticated session", () => {
    expect(
      isRecentPartnerEmailChangeAuthentication({
        authMethod: "password",
        sessionCreatedAt: new Date(now.getTime() - 14 * 60_000),
        now,
      }),
    ).toBe(true);
    expect(
      isRecentPartnerEmailChangeAuthentication({
        authMethod: "magic_link",
        sessionCreatedAt: now,
        now,
      }),
    ).toBe(false);
    expect(
      isRecentPartnerEmailChangeAuthentication({
        authMethod: "password",
        sessionCreatedAt: new Date(now.getTime() - 16 * 60_000),
        now,
      }),
    ).toBe(false);
  });
});

describe("Partner email-change containment contract", () => {
  it("binds one pending email-change challenge to an exact canonical subject", () => {
    const migration = source(
      "apps/api/src/db/migrations/0142_partner_email_change.sql",
    );
    expect(migration).toContain("'email_change'");
    expect(migration).toContain(
      '"partner_auth_challenges_active_email_change_user_key"',
    );
    expect(migration).toContain('"partner_user_id" IS NOT NULL');
    expect(migration).toContain('"partner_account_id" IS NOT NULL');
    expect(migration).toContain('"partner_membership_id" IS NOT NULL');
    expect(migration).toContain('"security_version_snapshot" IS NOT NULL');
  });

  it("rotates the identity security version, revokes sessions, and never creates a session", () => {
    const service = source("apps/api/src/lib/partner-email-change.ts");
    const consume = service.indexOf("const [consumed]");
    const identity = service.indexOf("const [updatedUser]", consume);
    const sessions = service.indexOf("const revokedSessions", identity);
    expect(consume).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(consume);
    expect(sessions).toBeGreaterThan(identity);
    expect(service).toContain("securityVersion: nextSecurityVersion");
    expect(service).toContain("autoLoginIssued: false");
    expect(service).not.toContain("insert(partnerSessions)");
    expect(service).not.toContain("contacts");
  });

  it("uses an explicit purpose URL and sends no login credential", () => {
    const purpose = source("apps/api/src/lib/partner-purpose-auth.ts");
    const delivery = source("apps/api/src/lib/partner-auth-email-delivery.ts");
    const confirmation = source(
      "apps/api/app/api/portal/v2/onboarding/email-change/confirm/route.ts",
    );
    expect(purpose).toContain('"/partners/confirm-email"');
    expect(delivery).toContain("The link confirms the mailbox only");
    expect(confirmation).toContain("autoLogin: false");
    expect(confirmation).not.toContain("sessionToken");
  });

  it("keeps request collision responses neutral and requires idempotency", () => {
    const requestRoute = source(
      "apps/api/app/api/portal/v2/security/email-change/request/route.ts",
    );
    const service = source("apps/api/src/lib/partner-email-change.ts");
    expect(requestRoute).toContain("readPortalV2IdempotencyKey");
    expect(requestRoute).toContain("If that address is eligible");
    expect(service).toContain('reason: "target_identity_unavailable"');
    expect(service).toContain('kind: "accepted", expiresAt: null');
  });
});
