import type { TeamSurfaceDefinition, TeamSurfaceGroup } from "@myst-os/sdk";
import type { Route } from "next";
import { hasTeamPermissionValue } from "../../lib/team-permissions";

export type { TeamSurfaceDefinition, TeamSurfaceGroup } from "@myst-os/sdk";

export const TEAM_SURFACES = [
  {
    id: "calendar",
    canonicalPath: "/team/calendar",
    legacyTabs: ["calendar", "myday", "estimates"],
    group: "daily",
    label: "Calendar",
    requiredPermissions: ["appointments.read"],
    subviews: ["day", "week", "month"],
  },
  {
    id: "inbox",
    canonicalPath: "/team/inbox",
    legacyTabs: ["inbox"],
    group: "daily",
    label: "Inbox",
    requiredPermissions: ["messages.read"],
    subviews: ["needs-reply", "waiting", "failed", "all"],
  },
  {
    id: "contacts",
    canonicalPath: "/team/contacts",
    legacyTabs: ["contacts"],
    group: "daily",
    label: "Contacts",
    requiredPermissions: ["contacts.read"],
    subviews: [
      "overview",
      "properties",
      "activity",
      "jobs-quotes",
      "communications",
      "intelligence",
    ],
  },
  {
    id: "quotes",
    canonicalPath: "/team/quotes/manage",
    legacyTabs: ["quotes", "quote-builder", "canvass"],
    group: "daily",
    label: "Quotes",
    requiredPermissions: ["quotes.read"],
    subviews: ["create", "manage", "instant"],
  },
  {
    id: "expenses",
    canonicalPath: "/team/expenses",
    legacyTabs: ["expenses"],
    group: "daily",
    label: "Expenses",
    requiredPermissions: ["expenses.read"],
    subviews: ["add", "ledger", "summary"],
  },
  {
    id: "pipeline",
    canonicalPath: "/team/sales/pipeline",
    legacyTabs: ["pipeline"],
    group: "sales",
    label: "Pipeline",
    requiredPermissions: ["pipeline.read"],
    subviews: ["board", "list"],
  },
  {
    id: "sales-hq",
    canonicalPath: "/team/sales/hq",
    legacyTabs: ["sales-hq"],
    group: "sales",
    label: "Sales HQ",
    requiredPermissions: ["sales.read"],
    subviews: ["queue", "coaching", "activity"],
  },
  {
    id: "outbound",
    canonicalPath: "/team/sales/outbound",
    legacyTabs: ["outbound"],
    group: "sales",
    label: "Outbound",
    requiredPermissions: ["outbound.read"],
    subviews: ["queue", "import", "partners"],
  },
  {
    id: "partners",
    canonicalPath: "/team/sales/outbound/partners",
    legacyTabs: ["partners"],
    group: "sales",
    label: "Partners",
    requiredPermissions: ["partners.read"],
    subviews: ["overview", "referrals-touches", "portal-users", "rates"],
  },
  {
    id: "sales-log",
    canonicalPath: "/team/sales/hq/activity",
    legacyTabs: ["sales-log"],
    group: "sales",
    label: "Sales Activity",
    requiredPermissions: ["sales.read"],
    subviews: ["activity"],
  },
  {
    id: "google-ads",
    canonicalPath: "/team/marketing/ads",
    legacyTabs: ["google-ads", "marketing"],
    group: "marketing",
    label: "Ads",
    requiredPermissions: ["marketing.read"],
    subviews: ["overview", "recommendations", "reports", "settings"],
  },
  {
    id: "web-analytics",
    canonicalPath: "/team/marketing/website",
    legacyTabs: ["web-analytics"],
    group: "marketing",
    label: "Website",
    requiredPermissions: ["marketing.read"],
    subviews: ["summary", "funnel", "errors", "vitals"],
  },
  {
    id: "seo",
    canonicalPath: "/team/marketing/seo",
    legacyTabs: ["seo"],
    group: "marketing",
    label: "SEO",
    requiredPermissions: ["marketing.read"],
    subviews: ["readiness", "drafts", "history", "settings"],
  },
  {
    id: "owner",
    canonicalPath: "/team/owner",
    legacyTabs: ["owner"],
    group: "owner",
    label: "Owner HQ",
    requiredPermissions: ["finance.read"],
    subviews: [
      "overview",
      "revenue",
      "payments",
      "expenses",
      "payroll",
      "p-and-l",
      "assistant",
    ],
  },
  {
    id: "policy",
    canonicalPath: "/team/admin/policy",
    legacyTabs: ["policy"],
    group: "admin",
    label: "Policy Center",
    requiredPermissions: ["policy.read"],
    subviews: [
      "business",
      "service-area",
      "booking",
      "messaging",
      "pricing",
      "templates",
      "reviews",
    ],
  },
  {
    id: "automation",
    canonicalPath: "/team/admin/automation",
    legacyTabs: ["automation"],
    group: "admin",
    label: "Messaging Automation",
    requiredPermissions: ["automation.read"],
    subviews: ["modes", "channels", "lead-controls", "history"],
  },
  {
    id: "commissions",
    canonicalPath: "/team/admin/commissions",
    legacyTabs: ["commissions"],
    group: "admin",
    label: "Commissions",
    requiredPermissions: ["commissions.read"],
    subviews: ["draft", "review", "locked", "paid", "settings"],
  },
  {
    id: "access",
    canonicalPath: "/team/admin/access",
    legacyTabs: ["access"],
    group: "admin",
    label: "Access",
    requiredPermissions: ["access.manage"],
    subviews: ["members", "roles", "routing", "sessions"],
  },
  {
    id: "audit",
    canonicalPath: "/team/admin/audit",
    legacyTabs: ["audit"],
    group: "admin",
    label: "Audit Log",
    requiredPermissions: ["audit.read"],
    subviews: ["events"],
  },
  {
    id: "merge",
    canonicalPath: "/team/admin/merge",
    legacyTabs: ["merge"],
    group: "admin",
    label: "Merge Queue",
    requiredPermissions: ["contacts.merge"],
    subviews: ["queue", "history"],
  },
  {
    id: "chat",
    canonicalPath: "/team/tools/agent",
    legacyTabs: ["chat"],
    group: "tools",
    label: "Agent",
    requiredPermissions: ["messages.read"],
    subviews: ["conversation", "proposed-actions"],
  },
  {
    id: "simulated-chat",
    canonicalPath: "/team/tools/simulator",
    legacyTabs: ["simulated-chat"],
    group: "tools",
    label: "Simulator",
    requiredPermissions: ["automation.simulate"],
    subviews: ["setup", "transcript", "result"],
  },
  {
    id: "settings",
    canonicalPath: "/team/settings",
    legacyTabs: ["settings"],
    group: "personal",
    label: "Settings",
    requiredPermissions: [],
    subviews: ["profile", "password", "sessions", "preferences"],
  },
] as const satisfies readonly TeamSurfaceDefinition[];

export type TeamSurfaceId = (typeof TEAM_SURFACES)[number]["id"];

export const TEAM_SURFACE_BY_ID = new Map(
  TEAM_SURFACES.map((surface) => [surface.id, surface]),
);

export const TEAM_SURFACE_IDS = new Set<TeamSurfaceId>(
  TEAM_SURFACES.map((surface) => surface.id),
);

export function isTeamSurfaceId(value: string): value is TeamSurfaceId {
  return TEAM_SURFACE_IDS.has(value as TeamSurfaceId);
}

export type TeamSurfaceQueryPrimitive = string | number | boolean;

export type TeamSurfaceQueryValue =
  | TeamSurfaceQueryPrimitive
  | readonly TeamSurfaceQueryPrimitive[]
  | null
  | undefined;

export type TeamSurfaceHrefOptions = {
  query?: Readonly<Record<string, TeamSurfaceQueryValue>> | URLSearchParams;
  hash?: string | null;
};

const TEAM_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const TEAM_RESERVED_QUERY_KEYS = new Set(["tab", "_canonical"]);

/**
 * Builds an internal URL from the canonical Team surface registry.
 *
 * Callers pass raw values. URLSearchParams handles their encoding so links do
 * not need (and must not add) their own encodeURIComponent calls. The legacy
 * `tab` and internal `_canonical` keys are intentionally rejected: the route
 * identifies the surface, while the catch-all route owns `_canonical`.
 */
export function teamSurfaceHref(
  surfaceId: TeamSurfaceId,
  options: TeamSurfaceHrefOptions = {},
): Route {
  const surface = TEAM_SURFACE_BY_ID.get(surfaceId);
  if (!surface) {
    throw new TypeError(`Unknown Team surface: ${surfaceId}`);
  }

  const search = new URLSearchParams();
  const queryEntries: ReadonlyArray<readonly [string, TeamSurfaceQueryValue]> =
    options.query instanceof URLSearchParams
      ? Array.from(options.query.entries())
      : Object.entries(options.query ?? {});
  for (const [key, rawValue] of queryEntries) {
    if (
      !TEAM_QUERY_KEY_PATTERN.test(key) ||
      TEAM_RESERVED_QUERY_KEYS.has(key)
    ) {
      throw new TypeError(`Unsafe Team query parameter: ${key}`);
    }

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      search.append(key, String(value));
    }
  }

  const query = search.toString();
  const rawHash = options.hash?.replace(/^#+/u, "") ?? "";
  const hash = rawHash ? `#${encodeURIComponent(rawHash)}` : "";
  return `${surface.canonicalPath}${query ? `?${query}` : ""}${hash}` as Route;
}

export const TEAM_SURFACE_GROUP_LABELS: Readonly<
  Record<TeamSurfaceGroup, string>
> = {
  daily: "Daily work",
  sales: "Sales",
  marketing: "Marketing",
  owner: "Owner",
  admin: "Administration",
  tools: "Advanced tools",
  personal: "Personal",
};

export const TEAM_SURFACE_GROUP_ORDER: readonly TeamSurfaceGroup[] = [
  "daily",
  "sales",
  "marketing",
  "owner",
  "admin",
  "tools",
  "personal",
];

export function legacyTeamSurfaceHref(surfaceId: TeamSurfaceId): string {
  return `/team?tab=${encodeURIComponent(surfaceId)}`;
}

export function resolveDefaultTeamSurfaceId(
  permissions: readonly string[],
): TeamSurfaceId | null {
  const allowed = (surface: (typeof TEAM_SURFACES)[number]): boolean =>
    surface.requiredPermissions.length === 0 ||
    surface.requiredPermissions.some((permission) =>
      hasTeamPermissionValue(permissions, permission),
    );

  const isFieldRole =
    hasTeamPermissionValue(permissions, "appointments.read") &&
    hasTeamPermissionValue(permissions, "appointments.update") &&
    !hasTeamPermissionValue(permissions, "messages.write") &&
    !hasTeamPermissionValue(permissions, "messages.send") &&
    !hasTeamPermissionValue(permissions, "bookings.manage") &&
    !hasTeamPermissionValue(permissions, "*");
  if (isFieldRole) {
    const calendar = TEAM_SURFACE_BY_ID.get("calendar");
    if (calendar && allowed(calendar)) return "calendar";
  }

  const inbox = TEAM_SURFACE_BY_ID.get("inbox");
  if (inbox && allowed(inbox)) return "inbox";
  return TEAM_SURFACES.find(allowed)?.id ?? null;
}
