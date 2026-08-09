import {
  isBuiltInTeamRoleSlug,
  isTeamRoleSlugUniqueViolation,
  isValidTeamRoleSlug,
  normalizeTeamRoleSlug,
} from "@/lib/team-role-input";

describe("team role input", () => {
  it("normalizes slugs and recognizes every protected built-in slug", () => {
    expect(normalizeTeamRoleSlug("  Custom_Sales  ")).toBe("custom_sales");
    expect(isBuiltInTeamRoleSlug(" OWNER ")).toBe(true);
    expect(isBuiltInTeamRoleSlug("read_only")).toBe(true);
    expect(isBuiltInTeamRoleSlug("custom_owner")).toBe(false);
  });

  it("accepts only bounded stable custom-role identifiers", () => {
    expect(isValidTeamRoleSlug(" Field_Sales-East ")).toBe(true);
    expect(isValidTeamRoleSlug("a2")).toBe(true);
    expect(isValidTeamRoleSlug("a")).toBe(false);
    expect(isValidTeamRoleSlug("2_sales")).toBe(false);
    expect(isValidTeamRoleSlug("sales east")).toBe(false);
    expect(isValidTeamRoleSlug("sales/east")).toBe(false);
    expect(isValidTeamRoleSlug(`a${"b".repeat(64)}`)).toBe(false);
  });

  it("only classifies the team role slug constraint as a slug conflict", () => {
    expect(
      isTeamRoleSlugUniqueViolation({
        code: "23505",
        constraint: "team_roles_slug_key",
      }),
    ).toBe(true);
    expect(
      isTeamRoleSlugUniqueViolation({
        cause: {
          code: "23505",
          message: "duplicate key violates team_roles_slug_key",
        },
      }),
    ).toBe(true);
    expect(
      isTeamRoleSlugUniqueViolation({
        code: "23505",
        constraint: "team_members_email_normalized_key",
      }),
    ).toBe(false);
  });
});
