import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  TEAM_READ_ONLY_PERMISSIONS,
  TEAM_ROLE_PERMISSION_TEMPLATES,
} from "@myst-os/sdk";
import { getDefaultPermissionsForRole } from "@/lib/permissions";
import {
  ACCESS_ROLE_TEMPLATE_OPTIONS,
  describeAccessPermission,
  getAccessRoleTemplate,
  normalizeAccessRolePermissionSelection,
} from "../../../site/src/app/team/access-role-templates";

const ROOT = join(process.cwd(), "../..");
const ROLE_FORM = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/RoleCreateForm.tsx"),
  "utf8",
);

describe("Access role templates", () => {
  it("shares the exact built-in work baselines between API and Access", () => {
    for (const template of ACCESS_ROLE_TEMPLATE_OPTIONS) {
      expect(getDefaultPermissionsForRole(template.id)).toEqual([
        ...TEAM_ROLE_PERMISSION_TEMPLATES[template.id].permissions,
      ]);
    }
  });

  it("only contains explicitly assignable permissions", () => {
    const assignable = new Set<string>(TEAM_ASSIGNABLE_PERMISSION_CATALOG);
    for (const template of ACCESS_ROLE_TEMPLATE_OPTIONS) {
      expect(template.permissions.length).toBeGreaterThan(0);
      expect(
        template.permissions.every((permission) => assignable.has(permission)),
      ).toBe(true);
    }
  });

  it("keeps privileged administration and irreversible owner work out of templates", () => {
    const excluded = [
      "access.manage",
      "access.break_glass",
      "audit.export",
      "contacts.purge",
      "messages.export",
      "partners.invite",
      "partners.rates",
      "payments.manage",
      "payments.reconcile",
      "commissions.manage",
      "commissions.pay",
      "marketing.apply",
      "marketing.publish",
      "outbox.dispatch",
    ];
    for (const template of ACCESS_ROLE_TEMPLATE_OPTIONS) {
      expect(template.permissions).toEqual(
        expect.not.arrayContaining(excluded),
      );
    }
  });

  it("keeps the read-only template equal to the explicit read baseline", () => {
    expect(TEAM_ROLE_PERMISSION_TEMPLATES.read_only.permissions).toEqual(
      TEAM_READ_ONLY_PERMISSIONS,
    );
    expect(
      TEAM_ROLE_PERMISSION_TEMPLATES.read_only.permissions.every((permission) =>
        permission.endsWith(".read"),
      ),
    ).toBe(true);
  });

  it("normalizes selections without accepting forged or duplicate values", () => {
    expect(
      normalizeAccessRolePermissionSelection([
        " messages.read ",
        "messages.read",
        "messages.*",
        "access.break_glass",
        "appointments.read",
      ]),
    ).toEqual(["appointments.read", "messages.read"]);
    expect(getAccessRoleTemplate("owner")).toBeNull();
    expect(getAccessRoleTemplate("sales")?.label).toBe("Sales representative");
  });

  it("gives every assignable permission a plain-English risk-aware label", () => {
    for (const permission of TEAM_ASSIGNABLE_PERMISSION_CATALOG) {
      const presentation = describeAccessPermission(permission);
      expect(presentation.label).not.toContain(".");
      expect(presentation.label).not.toContain("_");
      expect(presentation.label.length).toBeGreaterThan(4);
    }
    expect(describeAccessPermission("messages.read")).toEqual({
      label: "View conversations",
      sensitive: false,
    });
    expect(describeAccessPermission("payments.reconcile")).toEqual({
      label: "Resolve payment mismatches",
      sensitive: true,
    });
    expect(describeAccessPermission("expenses.submit")).toEqual({
      label: "Submit expenses for review",
      sensitive: true,
    });
    expect(describeAccessPermission("expenses.approve")).toEqual({
      label: "Approve submitted expenses",
      sensitive: true,
    });
    expect(describeAccessPermission("financials.read")).toEqual({
      label: "View expense financial overview",
      sensitive: true,
    });
    expect(describeAccessPermission("ad_spend.write")).toEqual({
      label: "Enter daily ad spend",
      sensitive: true,
    });
  });

  it("requires explicit application and review with accessible feedback", () => {
    expect(ROLE_FORM).toContain('pattern={"[A-Za-z][A-Za-z0-9_\\\\-]{1,63}"}');
    expect(ROLE_FORM).not.toContain('pattern="[A-Za-z][A-Za-z0-9_-]{1,63}"');
    expect(ROLE_FORM).toContain('type="button"');
    expect(ROLE_FORM).toContain("Apply selected template");
    expect(ROLE_FORM).toContain("never grants access until");
    expect(ROLE_FORM).toContain("Built-in Owner access is");
    expect(ROLE_FORM).toContain('role="status"');
    expect(ROLE_FORM).toContain('aria-live="polite"');
    expect(ROLE_FORM).toContain("min-h-[52px]");
    expect(ROLE_FORM).toContain("Create reviewed role");
    expect(ROLE_FORM).toContain("describeAccessPermission");
    expect(ROLE_FORM).toContain("Sensitive");
    expect(ROLE_FORM).toContain("TEAM_INPUT");
    expect(ROLE_FORM).toContain("TEAM_SELECT");
    expect(ROLE_FORM).toContain("teamButtonClass");
    expect(ROLE_FORM).toContain("var(--team-text)");
    expect(ROLE_FORM).not.toContain("bg-white");
  });
});
