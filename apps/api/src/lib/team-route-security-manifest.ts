/**
 * Static policy for the API routes reached by the authenticated `/team` CRM.
 *
 * The route inventory itself is generated recursively from API route files in
 * companion Jest test. Keeping the policy here makes additions reviewable
 * without importing route modules (which may connect to providers or a DB).
 */

import {
  TEAM_PERMISSION_CATALOG,
  type ActionPolicy,
  type ActionRisk,
  type TeamPermission,
} from "@myst-os/sdk";

export const TEAM_ROUTE_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export type TeamRouteHttpMethod = (typeof TEAM_ROUTE_HTTP_METHODS)[number];

export type TeamActionRisk = ActionRisk;

export type TeamRouteSecurityContract = ActionPolicy & {
  route: string;
  method: TeamRouteHttpMethod;
  permissions: TeamPermission[];
  auditRequired: boolean;
  auditActionExpectation: string | null;
  serviceOnly: boolean;
};

/** Paths are relative to `apps/api`. */
export const TEAM_ROUTE_SECURITY_ROOTS = [
  "app/api/admin",
  "app/api/appointment-media",
  "app/api/appointments",
  "app/api/calendar/status",
  "app/api/payments",
  "app/api/quotes",
  "app/api/revenue",
  "app/api/mobile/offline-media-queue-health",
  "app/api/web/appointments/[id]/reschedule",
] as const;

export type TeamRouteSecurityExemption = {
  route: string;
  method: TeamRouteHttpMethod;
  kind: "signed_callback";
  reason: string;
  requiredEvidence: readonly string[];
  risk: TeamActionRisk;
  requiresIdempotency: boolean;
  auditActionExpectation: string;
};

/** There are no exemptions from the verified team mutation boundary. */
export const TEAM_ROUTE_SECURITY_EXEMPTIONS: readonly TeamRouteSecurityExemption[] =
  [];

/**
 * Protected shared routes that are not yet in the CI-enforced `/team` set.
 * This is a migration backlog, not an authorization exemption. The test locks
 * the list so a new deferred route cannot be added accidentally.
 */
export const TEAM_ROUTE_SECURITY_MIGRATION_BACKLOG =
  [] as const satisfies readonly {
    route: string;
    methods: readonly TeamRouteHttpMethod[];
    reason: string;
  }[];

const FINANCIAL_ROUTE_PATTERN =
  /\/(?:commissions|expenses|final-total|manual-payments|payment-attempts|payments|plaid|revenue|stripe)(?:\/|$)/u;
const EXTERNAL_ROUTE_PATTERN =
  /\/(?:calls\/start|eta\/drafts\/[^/]+\/send|google\/ads\/analyst\/recommendations\/apply|inbox\/messages\/[^/]+\/retry|inbox\/threads\/[^/]+\/messages|meta\/ads\/sync|outbox\/dispatch|quotes\/[^/]+\/send|seo\/(?:run|posts\/[^/]+\/publish))(?:\/|$)/u;
const DESTRUCTIVE_ROUTE_PATTERN =
  /\/(?:merge|merge-suggestions|purge|sales\/reset|stripe\/backfill)(?:\/|$)/u;

const HUMAN_ONLY_ROUTE_KEYS = new Set([
  "app/api/admin/contacts/[contactId]/purge/route.ts#GET",
  "app/api/admin/contacts/[contactId]/purge/route.ts#POST",
  "app/api/appointments/[id]/manual-payments/route.ts#POST",
  "app/api/appointments/[id]/payment-attempts/route.ts#POST",
  "app/api/payments/square/return/route.ts#POST",
]);

const RISK_OVERRIDES: Readonly<Record<string, TeamActionRisk>> = {
  "app/api/admin/roles/[roleId]/route.ts#PATCH": "destructive",
  "app/api/admin/automation/route.ts#POST": "external",
  "app/api/admin/inbox/export/jsonl/route.ts#POST": "read",
  "app/api/admin/inbox/export/jsonl/route.ts#PUT": "read",
  "app/api/admin/partners/users/route.ts#POST": "external",
  "app/api/admin/partners/users/route.ts#PATCH": "destructive",
  "app/api/admin/partners/invite-operations/route.ts#POST": "destructive",
  "app/api/admin/sales/autopilot/route.ts#PATCH": "external",
  "app/api/admin/outbox/dispatch/route.ts#POST": "external",
  "app/api/admin/seo/run/route.ts#POST": "external",
  "app/api/admin/seo/posts/[postId]/publish/route.ts#POST": "external",
  "app/api/appointment-media/[id]/restore/route.ts#POST": "destructive",
  "app/api/appointments/[id]/route.ts#PATCH": "financial",
  "app/api/appointments/[id]/convert/route.ts#POST": "financial",
  "app/api/appointments/[id]/manual-payments/route.ts#POST": "financial",
  "app/api/appointments/[id]/payment-attempts/route.ts#POST": "financial",
  "app/api/appointments/[id]/sold-by/route.ts#POST": "financial",
  "app/api/quotes/[id]/decision/route.ts#POST": "normal",
};

function routeKey(route: string, method: TeamRouteHttpMethod): string {
  return `${route}#${method}`;
}

export function routeIsInTeamSecurityScope(route: string): boolean {
  return TEAM_ROUTE_SECURITY_ROOTS.some(
    (root) => route === `${root}/route.ts` || route.startsWith(`${root}/`),
  );
}

export function classifyTeamActionRisk(
  route: string,
  method: TeamRouteHttpMethod,
): TeamActionRisk {
  const override = RISK_OVERRIDES[routeKey(route, method)];
  if (override) return override;
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "DELETE" || DESTRUCTIVE_ROUTE_PATTERN.test(route)) {
    return "destructive";
  }
  if (FINANCIAL_ROUTE_PATTERN.test(route)) return "financial";
  if (EXTERNAL_ROUTE_PATTERN.test(route)) return "external";
  return "normal";
}

function actionSlug(route: string, method: TeamRouteHttpMethod): string {
  const path = route
    .replace(/^app\/api\//u, "")
    .replace(/\/route\.ts$/u, "")
    .replace(/\[([^\]]+)\]/gu, "$1")
    .replace(/[^a-zA-Z0-9]+/gu, ".")
    .replace(/^\.|\.$/gu, "")
    .toLowerCase();
  return `team_api.${path}.${method.toLowerCase()}`;
}

export function buildTeamRouteSecurityContract(input: {
  route: string;
  method: TeamRouteHttpMethod;
  permissions: readonly string[];
}): TeamRouteSecurityContract {
  const knownPermissions = new Set<string>(TEAM_PERMISSION_CATALOG);
  const unknownPermissions = input.permissions.filter(
    (permission) => !knownPermissions.has(permission),
  );
  if (unknownPermissions.length > 0) {
    throw new Error(
      `Unknown team permission(s): ${unknownPermissions.join(", ")}`,
    );
  }
  const requiredPermissions = [...input.permissions] as TeamPermission[];
  const pathRisk = classifyTeamActionRisk(input.route, input.method);
  const isRead = input.method === "GET" || input.method === "HEAD";
  const permissionRisk = input.permissions.some((permission) =>
    /^(?:commissions|expenses|payments)\.(?:collect|manage|pay|write)$/u.test(
      permission,
    ),
  )
    ? "financial"
    : input.permissions.some((permission) =>
          /^(?:marketing\.(?:apply|publish)|messages\.send|outbox\.dispatch|quotes\.send)$/u.test(
            permission,
          ),
        )
      ? "external"
      : null;
  const risk =
    pathRisk === "destructive" || isRead
      ? pathRisk
      : (permissionRisk ?? pathRisk);
  const auditRequired =
    !isRead || /\/(?:audit|export|receipt|media)(?:\/|$)/u.test(input.route);
  const serviceOnly =
    input.method === "POST" &&
    (input.route === "app/api/admin/outbox/dispatch/route.ts" ||
      input.route === "app/api/admin/team/break-glass/exchange/route.ts");
  const humanOnly = HUMAN_ONLY_ROUTE_KEYS.has(
    routeKey(input.route, input.method),
  );
  const auditAction = actionSlug(input.route, input.method);

  return {
    route: input.route,
    method: input.method,
    permissions: requiredPermissions,
    principalTypes: serviceOnly
      ? ["service"]
      : humanOnly
        ? ["human"]
        : ["human", "service"],
    requiredPermissions,
    risk,
    requiresIdempotency:
      !isRead &&
      (risk === "external" || risk === "financial" || risk === "destructive"),
    auditRequired,
    auditActionExpectation: auditRequired ? auditAction : null,
    auditAction,
    serviceOnly,
  };
}
