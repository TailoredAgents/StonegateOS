import fs from "node:fs";
import path from "node:path";
import {
  isTeamMemberPhoneUniqueViolation,
  normalizeTeamMemberPhoneE164,
  selectUnambiguousActiveIdentity,
} from "@/lib/team-member-identity";

describe("team member phone identity", () => {
  it("normalizes supported US and international input to deterministic E.164", () => {
    expect(normalizeTeamMemberPhoneE164("6785551212")).toBe("+16785551212");
    expect(normalizeTeamMemberPhoneE164("(678) 555-1212")).toBe("+16785551212");
    expect(normalizeTeamMemberPhoneE164("+44 20 7946 0958")).toBe(
      "+442079460958",
    );
  });

  it("rejects empty, malformed, and non-E.164-length identities", () => {
    expect(normalizeTeamMemberPhoneE164(null)).toBeNull();
    expect(normalizeTeamMemberPhoneE164("   ")).toBeNull();
    expect(normalizeTeamMemberPhoneE164("not-a-phone")).toBeNull();
    expect(normalizeTeamMemberPhoneE164("123")).toBeNull();
  });

  it("fails closed for missing, inactive, or ambiguous identity matches", () => {
    const active = { id: "member-1", active: true };
    expect(selectUnambiguousActiveIdentity([active])).toBe(active);
    expect(selectUnambiguousActiveIdentity([])).toBeNull();
    expect(
      selectUnambiguousActiveIdentity([{ id: "member-1", active: false }]),
    ).toBeNull();
    expect(
      selectUnambiguousActiveIdentity([
        active,
        { id: "member-2", active: true },
      ]),
    ).toBeNull();
  });

  it("identifies only the team phone index as a phone conflict", () => {
    expect(
      isTeamMemberPhoneUniqueViolation({
        code: "23505",
        constraint_name: "team_members_phone_e164_key",
      }),
    ).toBe(true);
    expect(
      isTeamMemberPhoneUniqueViolation({
        cause: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "team_members_phone_e164_key"',
        },
      }),
    ).toBe(true);
    expect(
      isTeamMemberPhoneUniqueViolation({
        code: "23505",
        constraint_name: "team_members_pkey",
      }),
    ).toBe(false);
  });
});

describe("team phone identity rollout contracts", () => {
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      "../db/migrations/0062_team_member_phone_identity.sql",
    ),
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

  it("backfills only unambiguous valid values before adding database guards", () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "phone_e164"');
    expect(migration).toContain("HAVING count(*) = 1");
    expect(migration).toContain("ELSE NULL");
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "team_members_phone_e164_format"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "team_members_phone_e164_key"',
    );
  });

  it("uses the member column—not policy JSON—as the login identity source", () => {
    expect(authSource).toContain("teamMembers.phoneE164");
    expect(authSource).toContain(
      ".where(eq(teamMembers.phoneE164, normalizedPhone))",
    );
    expect(authSource).not.toContain("team_member_phones");
    expect(authSource).not.toContain("policySettings");
  });

  it("normalizes create/edit writes and maps uniqueness conflicts to 409", () => {
    for (const source of [memberListRoute, memberDetailRoute]) {
      expect(source).toContain("normalizeTeamMemberPhoneE164");
      expect(source).toContain("isTeamMemberPhoneUniqueViolation");
      expect(source).toContain('new TeamMutationFailure(\n            "conflict"');
      expect(source).toContain(
        'fieldErrors: { phone: "Use a unique member phone." }',
      );
      expect(source).toContain("teamMembers.phoneE164");
    }
    expect(memberDetailRoute).toContain('updates["phoneE164"]');
    expect(memberListRoute).toContain(
      "Authentication never reads this compatibility copy",
    );
  });
});
