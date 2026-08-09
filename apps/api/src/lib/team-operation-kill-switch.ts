import type { ActionPolicy, TeamPermission } from "@myst-os/sdk";

export type TeamOperationKillSwitch =
  | "external_sends"
  | "financial_mutations"
  | "destructive_mutations"
  | "advertising_changes"
  | "publishing"
  | "outbox_dispatch";

const KILL_SWITCH_PERMISSIONS: ReadonlyArray<{
  category: TeamOperationKillSwitch;
  env: string;
  permissions: ReadonlySet<TeamPermission>;
}> = [
  {
    category: "external_sends",
    env: "TEAM_KILL_EXTERNAL_SENDS",
    permissions: new Set([
      "calls.place",
      "messages.send",
      "quotes.send",
      "partners.invite",
    ]),
  },
  {
    category: "financial_mutations",
    env: "TEAM_KILL_FINANCIAL_MUTATIONS",
    permissions: new Set([
      "expenses.write",
      "payments.collect",
      "payments.manage",
      "commissions.manage",
      "commissions.pay",
      "partners.rates",
    ]),
  },
  {
    category: "destructive_mutations",
    env: "TEAM_KILL_DESTRUCTIVE_MUTATIONS",
    permissions: new Set([
      "contacts.delete",
      "contacts.purge",
      "contacts.merge",
      "properties.delete",
      "quotes.delete",
    ]),
  },
  {
    category: "advertising_changes",
    env: "TEAM_KILL_ADVERTISING_CHANGES",
    permissions: new Set(["marketing.apply"]),
  },
  {
    category: "publishing",
    env: "TEAM_KILL_PUBLISHING",
    permissions: new Set(["marketing.publish"]),
  },
  {
    category: "outbox_dispatch",
    env: "TEAM_KILL_OUTBOX_DISPATCH",
    permissions: new Set(["outbox.dispatch"]),
  },
];

function envSwitchEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function getTeamOperationKillSwitch(
  requiredPermissions: readonly TeamPermission[],
  options: {
    ignoredCategories?: readonly TeamOperationKillSwitch[];
  } = {},
): TeamOperationKillSwitch | null {
  const ignoredCategories = new Set(options.ignoredCategories ?? []);
  for (const entry of KILL_SWITCH_PERMISSIONS) {
    if (ignoredCategories.has(entry.category)) continue;
    if (!envSwitchEnabled(entry.env)) continue;
    if (
      requiredPermissions.some((permission) =>
        entry.permissions.has(permission),
      )
    ) {
      return entry.category;
    }
  }
  return null;
}

/**
 * Policy risk is the fail-safe containment boundary. Permission mappings
 * remain useful for legacy routes which have not adopted `beginTeamMutation`,
 * but a newly introduced high-risk permission must not bypass an emergency
 * switch merely because it was omitted from the permission map.
 */
export function getTeamOperationKillSwitchForRisk(
  risk: ActionPolicy["risk"],
): TeamOperationKillSwitch | null {
  if (risk === "external" && envSwitchEnabled("TEAM_KILL_EXTERNAL_SENDS")) {
    return "external_sends";
  }
  if (
    risk === "financial" &&
    envSwitchEnabled("TEAM_KILL_FINANCIAL_MUTATIONS")
  ) {
    return "financial_mutations";
  }
  if (
    risk === "destructive" &&
    envSwitchEnabled("TEAM_KILL_DESTRUCTIVE_MUTATIONS")
  ) {
    return "destructive_mutations";
  }
  return null;
}
