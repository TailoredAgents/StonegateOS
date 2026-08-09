import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cleanupSource = readFileSync(
  resolve(process.cwd(), "../..", "tests/e2e/support/team-auth.ts"),
  "utf8",
);
const journeyCleanupSource = readFileSync(
  resolve(process.cwd(), "../..", "tests/e2e/audit/journey-fixtures.ts"),
  "utf8",
);

describe("Team audit fixture cleanup contract", () => {
  it("revokes every reusable fixture authentication path atomically", () => {
    expect(cleanupSource).toContain("await sql.begin");
    expect(cleanupSource).toContain("DELETE FROM team_sessions");
    expect(cleanupSource).toContain("DELETE FROM team_login_tokens");
    expect(cleanupSource).toContain("password_hash = NULL");
    expect(cleanupSource).toContain("password_set_at = NULL");
    expect(cleanupSource).toContain("phone_e164 = NULL");
  });

  it.each([
    ["appointment_crew_members", "member_id"],
    ["commission_management_splits", "member_id"],
    ["commission_crew_split_rules", "member_id"],
    ["partner_invite_operations", "resolved_by"],
  ])(
    "retains actors referenced by %s.%s instead of deleting business evidence",
    (table, column) => {
      expect(cleanupSource).toContain(`FROM ${table}`);
      expect(cleanupSource).toContain(`${column} = member.id`);
      expect(cleanupSource).not.toContain(`DELETE FROM ${table}`);
    },
  );

  it("keeps one credential-free synthetic owner for Access continuity", () => {
    expect(cleanupSource).toContain(
      "lower(member.email) = 'audit-owner@mystos.test'",
    );
    expect(cleanupSource).toContain(
      "permissions = ${ownerPermissions}::text[]",
    );
    expect(cleanupSource).toContain("email_normalized = NULL");
    expect(cleanupSource).toContain("email_identity_status = 'none'");
    expect(cleanupSource).toContain("active = true");
  });

  it("never deletes append-only manual financial evidence during cleanup", () => {
    expect(journeyCleanupSource).toContain(
      'if (manualExpenseId) {\n    // Manual ledger entries are deliberately append-only',
    );
    expect(journeyCleanupSource).not.toContain(
      "DELETE FROM expenses WHERE id = ${manualExpenseId}",
    );
    expect(journeyCleanupSource).toContain(
      'return "retained_for_shard_reset";',
    );
  });
});
