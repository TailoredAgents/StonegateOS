import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("partner account identity foundation", () => {
  const migration = read(
    "apps/api/src/db/migrations/0110_partner_account_identity_foundation.sql",
  );
  const schema = read("apps/api/src/db/schema.ts");

  it("registers one expand-only migration after 0109", () => {
    const journal = read("apps/api/src/db/migrations/meta/_journal.json");
    expect(
      journal.indexOf('"tag": "0109_expense_dump_ticket_details"'),
    ).toBeLessThan(
      journal.indexOf('"tag": "0110_partner_account_identity_foundation"'),
    );
    expect(migration).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE\s+FROM)\b/imu);
    expect(migration).not.toMatch(/ALTER\s+COLUMN[\s\S]*?SET\s+NOT\s+NULL/iu);
  });

  it("adds every account, access-review, capability, and MFA primitive", () => {
    for (const table of [
      "partner_mfa_methods",
      "partner_capability_definitions",
      "partner_role_templates",
      "partner_account_memberships",
      "partner_access_applications",
      "partner_company_join_requests",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    for (const schemaExport of [
      "partnerMfaMethods",
      "partnerCapabilityDefinitions",
      "partnerRoleTemplates",
      "partnerAccountMemberships",
      "partnerAccessApplications",
      "partnerCompanyJoinRequests",
    ]) {
      expect(schema).toContain(`export const ${schemaExport} = pgTable(`);
    }
  });

  it("backfills V1 contacts and users without reducing their authority", () => {
    expect(migration).toContain("partner_portal_legacy_backfill");
    expect(migration).toContain('UPDATE "contacts" contact');
    expect(migration).toContain('INSERT INTO "partner_account_memberships"');
    expect(migration).toContain("'f0000000-0000-4000-8000-000000000001'");
    expect(migration).toContain("'owner'");
    expect(migration).toContain("Owner-equivalent memberships preserve");
    expect(migration).toContain(
      'ON CONFLICT ("partner_account_id", "partner_user_id") DO NOTHING',
    );
    expect(migration).toContain('"persona"');
    expect(migration).toContain('"access_level"');
    expect(migration).toContain('"access_scope"');
    expect(migration).toContain('"preferences"');
  });

  it("binds a session to one matching user, membership, and account", () => {
    expect(migration).toContain(
      'CONSTRAINT "partner_account_memberships_session_identity_key"',
    );
    expect(migration).toContain(
      'CONSTRAINT "partner_sessions_active_membership_identity_fk"',
    );
    expect(migration).toContain('"active_partner_account_id"');
    expect(migration).toContain('"active_membership_id"');
    expect(migration).toContain(
      '"security_version" integer DEFAULT 1 NOT NULL',
    );
    expect(migration).toContain(
      "\"assurance_level\" text DEFAULT 'aal1' NOT NULL",
    );
    expect(migration).toContain('"mfa_verified_at" timestamp with time zone');
  });

  it("seeds bounded role templates instead of an untracked wildcard", () => {
    for (const role of [
      "owner",
      "admin",
      "scheduler",
      "approver",
      "billing",
      "viewer",
    ]) {
      expect(migration).toContain(`'${role}'`);
    }
    expect(migration).not.toContain("ARRAY['*']");
    expect(migration).toContain('"capability_grants" text[]');
    expect(migration).toContain('"capability_denies" text[]');
    expect(migration).toContain(
      'CHECK (NOT ("capability_grants" && "capability_denies"))',
    );
  });

  it("uses the shared review lifecycle for applications and join requests", () => {
    for (const status of [
      "submitted",
      "under_review",
      "needs_information",
      "approved",
      "declined",
      "withdrawn",
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).not.toContain("'pending'");
    expect(migration).not.toContain("'rejected'");
  });
});
