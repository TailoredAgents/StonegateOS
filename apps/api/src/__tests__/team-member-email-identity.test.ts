import fs from "node:fs";
import path from "node:path";
import {
  isTeamMemberEmailUniqueViolation,
  normalizeTeamMemberEmail,
} from "@/lib/team-member-identity";

describe("team member email identity", () => {
  it("normalizes non-empty identity input with one trim/lower contract", () => {
    expect(normalizeTeamMemberEmail("  Staff@Example.COM  ")).toBe(
      "staff@example.com",
    );
    expect(normalizeTeamMemberEmail("staff@example.com")).toBe(
      "staff@example.com",
    );
    expect(normalizeTeamMemberEmail(null)).toBeNull();
    expect(normalizeTeamMemberEmail("   ")).toBeNull();
    expect(normalizeTeamMemberEmail(123)).toBeNull();
  });

  it("identifies only the canonical team email uniqueness guard", () => {
    expect(
      isTeamMemberEmailUniqueViolation({
        code: "23505",
        constraint_name: "team_members_email_normalized_key",
      }),
    ).toBe(true);
    expect(
      isTeamMemberEmailUniqueViolation({
        cause: {
          code: "23505",
          message:
            'duplicate key violates unique constraint "team_members_email_normalized_key"',
        },
      }),
    ).toBe(true);
    expect(
      isTeamMemberEmailUniqueViolation({
        code: "23505",
        constraint_name: "team_members_phone_e164_key",
      }),
    ).toBe(false);
  });
});

describe("team email identity rollout contracts", () => {
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      "../db/migrations/0063_team_member_email_identity.sql",
    ),
    "utf8",
  );
  const journal = fs.readFileSync(
    path.resolve(__dirname, "../db/migrations/meta/_journal.json"),
    "utf8",
  );
  const schema = fs.readFileSync(
    path.resolve(__dirname, "../db/schema.ts"),
    "utf8",
  );
  const authSource = fs.readFileSync(
    path.resolve(__dirname, "../lib/team-auth.ts"),
    "utf8",
  );
  const memberListRoute = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin/team/members/route.ts"),
    "utf8",
  );
  const memberDetailRoute = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../app/api/admin/team/members/[memberId]/route.ts",
    ),
    "utf8",
  );
  const accessSection = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/team/components/AccessSection.tsx",
    ),
    "utf8",
  );

  it("is journaled immediately after the phone identity expansion", () => {
    expect(journal).toContain('"tag": "0062_team_member_phone_identity"');
    expect(journal).toContain('"tag": "0063_team_member_email_identity"');
    expect(journal.indexOf("0063_team_member_email_identity")).toBeGreaterThan(
      journal.indexOf("0062_team_member_phone_identity"),
    );
  });

  it("normalizes every legacy email and quarantines duplicate groups", () => {
    expect(migration).toContain("nullif(lower(btrim(email)), '')");
    expect(migration).toContain("PARTITION BY normalized.normalized_email");
    expect(migration).toContain("'needs_review'");
    expect(migration).toContain('"email_normalized" = CASE');
    expect(migration).not.toMatch(/DELETE FROM\s+"team_members"/u);
  });

  it("revokes ambiguous sessions and links before enabling canonical login", () => {
    expect(migration).toContain('UPDATE "team_sessions" session');
    expect(migration).toContain('DELETE FROM "team_login_tokens" token');
    expect(migration).toContain(
      "member.email_identity_status = 'needs_review'",
    );
  });

  it("enforces canonical, unique future writes at the database boundary", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "team_members_email_normalized_key"',
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_team_member_email_identity()",
    );
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF "email", "email_normalized", "email_identity_status"',
    );
    expect(migration).toContain(
      "lower(btrim(existing.email)) = canonical_email",
    );
    expect(migration).toContain("ERRCODE = '23505'");
    expect(schema).toContain('emailNormalized: text("email_normalized")');
    expect(schema).toContain(
      'emailIdentityStatus: text("email_identity_status")',
    );
  });

  it("authenticates only a ready canonical identity and retains ambiguity checks", () => {
    expect(authSource).toContain("teamMembers.emailNormalized");
    expect(authSource).toContain(
      ".where(eq(teamMembers.emailNormalized, normalizedEmail))",
    );
    expect(authSource).toContain("selectUnambiguousActiveIdentity");
    expect(authSource).not.toContain(
      "eq(sql`lower(btrim(${teamMembers.email}))`, normalizedEmail)",
    );
  });

  it("normalizes Access writes and maps conflicts to deterministic 409s", () => {
    for (const source of [memberListRoute, memberDetailRoute]) {
      expect(source).toContain("normalizeTeamMemberEmail");
      expect(source).toContain("isTeamMemberEmailUniqueViolation");
      expect(source).toContain('new TeamMutationFailure(\n          "conflict"');
      expect(source).toContain(
        'fieldErrors: { email: "Use a unique member email." }',
      );
      expect(source).toContain("emailNormalized");
      expect(source).toContain("emailIdentityStatus");
    }
    expect(memberDetailRoute).toContain("shouldRevokeMemberSessions");
  });

  it("surfaces quarantined accounts to Access reviewers", () => {
    expect(memberListRoute).toContain("emailMigrationStatus");
    expect(accessSection).toContain(
      'member.emailMigrationStatus === "needs_review"',
    );
    expect(accessSection).toContain("email login is disabled");
  });
});
