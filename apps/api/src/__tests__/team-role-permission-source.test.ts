import fs from "node:fs";
import path from "node:path";
import { getDefaultPermissionsForRole } from "@/lib/permissions";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("stored team-role permissions are the source of truth", () => {
  it("does not derive request-time authority from a role slug", () => {
    const permissionsSource = source("src/lib/permissions.ts");
    const authSource = source("src/lib/team-auth.ts");
    const roleMutationSource = source("app/api/admin/roles/[roleId]/route.ts");
    const memberMutationSource = source(
      "app/api/admin/team/members/[memberId]/route.ts",
    );

    // One occurrence is the provisioning helper's own declaration. Runtime
    // member/session resolution must not call it.
    expect(
      permissionsSource.match(/getDefaultPermissionsForRole\s*\(/gu),
    ).toHaveLength(1);
    expect(authSource).not.toContain("getDefaultPermissionsForRole");
    expect(roleMutationSource).not.toContain("getDefaultPermissionsForRole");
    expect(memberMutationSource).not.toContain("getDefaultPermissionsForRole");
    expect(authSource).not.toMatch(/roleSlug\s*===\s*["']owner["']/u);
  });

  it("materializes every built-in baseline across stored-permission migrations", () => {
    const baselineMigration = source(
      "src/db/migrations/0065_team_role_permission_baselines.sql",
    );
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    const entries = journal.entries ?? [];
    const baselineIndex = entries.findIndex(
      (entry) => entry.tag === "0065_team_role_permission_baselines",
    );
    expect(baselineIndex).toBeGreaterThanOrEqual(0);

    // Stored permissions became authoritative in 0065. Later capabilities
    // must be materialized by their additive migrations as defaults evolve.
    const materializationSource = entries
      .slice(Math.max(0, baselineIndex))
      .map((entry) => entry.tag)
      .filter((tag): tag is string => Boolean(tag))
      .map((tag) => source(`src/db/migrations/${tag}.sql`))
      .join("\n");

    for (const role of ["owner", "office", "sales", "crew", "read_only"]) {
      expect(baselineMigration).toContain(`'${role}'`);
      for (const permission of getDefaultPermissionsForRole(role)) {
        expect(materializationSource).toContain(`'${permission}'`);
      }
    }

    expect(baselineMigration).toContain(
      "array_remove(role.permissions, 'read')",
    );
    expect(baselineMigration).toContain(
      "array_remove(member.permissions_grant, 'read')",
    );
    expect(baselineMigration).toContain(
      "array_remove(member.permissions_deny, 'read')",
    );
  });

  it("registers the baseline migration after persisted auth methods", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const authMethodIndex = entries.findIndex(
      (entry) => entry.tag === "0064_team_session_auth_method",
    );
    expect(entries.slice(authMethodIndex, authMethodIndex + 2)).toEqual([
      expect.objectContaining({
        idx: 61,
        tag: "0064_team_session_auth_method",
      }),
      expect.objectContaining({
        idx: 62,
        tag: "0065_team_role_permission_baselines",
      }),
    ]);
  });
});
