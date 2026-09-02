import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("Partner account lifecycle and lost-Administrator controls", () => {
  it("persists a revisioned non-destructive lifecycle with actor evidence", () => {
    const migration = source(
      "src/db/migrations/0156_partner_account_lifecycle_and_auth_retention.sql",
    );
    expect(migration).toContain('"portal_lifecycle_status"');
    expect(migration).toContain("'active', 'suspended', 'closed', 'merged'");
    expect(migration).toContain(
      '"partner_accounts_portal_lifecycle_evidence_check"',
    );
    expect(migration).toContain(
      '"partner_accounts_portal_lifecycle_access_check"',
    );
    expect(migration).not.toContain('DELETE FROM "partner_accounts"');
  });

  it("keeps delegated lifecycle separate from owner-only closure and recovery", () => {
    const suspendRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/suspend/route.ts",
    );
    const closeRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/close/route.ts",
    );
    const recoveryRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/recover-administrator/route.ts",
    );
    expect(suspendRoute).toContain('"partners.accounts.lifecycle"');
    expect(closeRoute).toContain('"partners.accounts.close"');
    expect(recoveryRoute).toContain('"partners.memberships.recover_admin"');
    for (const route of [suspendRoute, closeRoute, recoveryRoute]) {
      expect(route).toContain('risk: "destructive"');
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    }
  });

  it("revokes credentials while explicitly preserving business records", () => {
    const service = source(
      "src/lib/partner-account-lifecycle-administration.ts",
    );
    const route = source(
      "src/lib/partner-account-lifecycle-mutation-route.ts",
    );
    expect(service).toContain("partnerSessions");
    expect(service).toContain("partnerAuthTransactions");
    expect(service).toContain("partnerAuthChallenges");
    expect(service).toContain("partnerAccountInvitations");
    expect(service).not.toContain(".delete(partnerAccounts)");
    expect(route).toContain("operationalAndFinancialRecordsPreserved: true");
    expect(route).toContain("explicitOwnerRecovery: true");
  });
});
