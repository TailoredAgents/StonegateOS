import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

type AccessState = {
  active: boolean;
  rolePermissions?: string[];
  grant?: string[];
  deny?: string[];
};

function permissionSetManagesAccess(permissions: string[] = []): boolean {
  return permissions
    .map((permission) => permission.trim())
    .some((permission) =>
      ["*", "access.*", "access.manage"].includes(permission),
    );
}

function effectivelyManagesAccess(state: AccessState): boolean {
  return (
    state.active &&
    (permissionSetManagesAccess(state.rolePermissions) ||
      permissionSetManagesAccess(state.grant)) &&
    !permissionSetManagesAccess(state.deny)
  );
}

function continuityAllows(
  protectionEnabled: boolean,
  finalMembers: AccessState[],
): boolean {
  return !protectionEnabled || finalMembers.some(effectivelyManagesAccess);
}

describe("database Team Access continuity guard", () => {
  const migration = apiSource(
    "src/db/migrations/0076_team_access_continuity_guard.sql",
  );
  const schema = apiSource("src/db/schema.ts");

  it("registers migration 0076 directly after durable Google Ads operations", () => {
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const adsIndex = entries.findIndex(
      (entry) => entry.tag === "0075_google_ads_recommendation_operations",
    );
    const continuityIndex = entries.findIndex(
      (entry) => entry.tag === "0076_team_access_continuity_guard",
    );

    expect(entries[adsIndex]).toEqual(expect.objectContaining({ idx: 72 }));
    expect(entries[continuityIndex]).toEqual(
      expect.objectContaining({ idx: 73 }),
    );
    expect(continuityIndex).toBe(adsIndex + 1);
  });

  it("defines effective access.manage from role or member grants with deny winning", () => {
    expect(
      effectivelyManagesAccess({
        active: true,
        rolePermissions: ["access.manage"],
      }),
    ).toBe(true);
    expect(
      effectivelyManagesAccess({
        active: true,
        rolePermissions: ["*"],
      }),
    ).toBe(true);
    expect(
      effectivelyManagesAccess({
        active: true,
        rolePermissions: ["access.*"],
      }),
    ).toBe(true);
    expect(
      effectivelyManagesAccess({
        active: true,
        rolePermissions: ["contacts.read"],
        grant: ["access.manage"],
      }),
    ).toBe(true);
    expect(
      effectivelyManagesAccess({
        active: false,
        rolePermissions: ["*"],
      }),
    ).toBe(false);

    for (const deny of ["*", "access.*", "access.manage"]) {
      expect(
        effectivelyManagesAccess({
          active: true,
          rolePermissions: ["*"],
          grant: ["access.manage"],
          deny: [deny],
        }),
      ).toBe(false);
    }

    expect(migration).toContain("IN ('*', 'access.*', 'access.manage')");
    expect(migration).toContain(
      'AND NOT "team_permission_set_manages_access"(p_permissions_deny)',
    );
    expect(migration).toContain(
      'LEFT JOIN "team_roles" AS role ON role."id" = member."role_id"',
    );
    expect(migration).not.toContain('role."slug"');
  });

  it("serializes direct member and role writes with the application lock", () => {
    expect(migration).toContain(
      "pg_advisory_xact_lock(hashtext('team_access_owner_safety_v1'))",
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_members_access_continuity_lock"',
    );
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE\nON "team_members"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_roles_access_continuity_lock"',
    );
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE\nON "team_roles"',
    );
    expect(migration).toContain("FOR UPDATE;");
    expect(migration).toContain('"updated_at" = clock_timestamp()');
  });

  it("checks the final transaction state for every relevant member and role mutation", () => {
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER "team_members_access_continuity_guard"',
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER "team_roles_access_continuity_guard"',
    );
    expect(migration.match(/AFTER INSERT OR UPDATE OR DELETE/gu)).toHaveLength(
      2,
    );
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2);
    expect(migration).toContain(
      "at least one active team member must retain effective access.manage",
    );
    expect(migration).toContain("team_access_continuity_requires_active_owner");
    expect(migration).toContain(
      "Add or promote another active Access administrator before removing the current one.",
    );
  });

  it("contracts every direct-SQL removal path and the safe transfer order", () => {
    const roleOwner: AccessState = {
      active: true,
      rolePermissions: ["access.manage"],
    };
    const grantOwner: AccessState = {
      active: true,
      rolePermissions: ["contacts.read"],
      grant: ["access.manage"],
    };

    // Member deletion, deactivation, role reassignment, grant removal, and a
    // deny all produce the same protected final-state failure.
    expect(continuityAllows(true, [])).toBe(false);
    expect(continuityAllows(true, [{ ...roleOwner, active: false }])).toBe(
      false,
    );
    expect(
      continuityAllows(true, [
        { ...roleOwner, rolePermissions: ["contacts.read"] },
      ]),
    ).toBe(false);
    expect(continuityAllows(true, [{ ...grantOwner, grant: [] }])).toBe(false);
    expect(
      continuityAllows(true, [{ ...roleOwner, deny: ["access.manage"] }]),
    ).toBe(false);

    // Removing/renaming a role is safe only when effective access.manage
    // survives. Slug-only changes never affect this permissions-based model.
    expect(
      continuityAllows(true, [{ ...roleOwner, rolePermissions: [] }]),
    ).toBe(false);
    expect(continuityAllows(true, [roleOwner])).toBe(true);
    expect(
      continuityAllows(true, [
        { ...roleOwner, rolePermissions: [], grant: ["access.manage"] },
      ]),
    ).toBe(true);

    // The supported transfer adds/promotes a replacement before the old
    // principal is demoted or deleted, so the final transaction still has one.
    expect(continuityAllows(true, [roleOwner, grantOwner])).toBe(true);
    expect(continuityAllows(true, [grantOwner])).toBe(true);
  });

  it("allows empty bootstrap and requires an explicit disposable-fixture opt-in before Team table truncation", () => {
    expect(continuityAllows(false, [])).toBe(true);
    expect(migration).toContain(
      '"protection_enabled" boolean DEFAULT false NOT NULL',
    );
    expect(migration).toContain(
      'SELECT "team_has_effective_access_manager"() AS enabled',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_members_access_continuity_truncate_authorize"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_roles_access_continuity_truncate_authorize"',
    );
    expect(migration.match(/BEFORE TRUNCATE/gu)).toHaveLength(2);
    expect(migration).toContain(
      "current_setting('stonegate.allow_team_access_fixture_reset', true)",
    );
    expect(migration).toContain(
      "SET LOCAL stonegate.allow_team_access_fixture_reset = ''on''",
    );
    expect(migration).toContain(
      "Team Access tables cannot be truncated without an explicit fixture-reset opt-in",
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_members_access_continuity_truncate_reset"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "team_roles_access_continuity_truncate_reset"',
    );
    expect(migration.match(/AFTER TRUNCATE/gu)).toHaveLength(2);
    expect(migration).toContain('"protection_enabled" = false');
    expect(migration).toContain(
      "Empty and not-yet-configured databases remain valid during bootstrap.",
    );
    expect(schema).toContain(
      "export const teamAccessContinuityState = pgTable(",
    );
    expect(schema).toContain('"team_access_continuity_state"');
    expect(schema).toContain('"team_access_continuity_state_singleton"');
  });

  it("rebuilds the latch before relevant writes so support-row tampering cannot bypass it", () => {
    expect(migration).toContain(
      'IF "team_has_effective_access_manager"() THEN',
    );
    expect(migration).toContain(
      "VALUES (true, true, statement_timestamp(), clock_timestamp())",
    );
    expect(migration).toContain('"protection_enabled" = true');
    expect(migration).toMatch(
      /later ordinary member\/role UPDATE or DELETE cannot bypass continuity by\s+-- clearing the support table first\./u,
    );
    expect(migration).not.toContain(
      'BEFORE TRUNCATE\nON "team_access_continuity_state"',
    );
  });
});
