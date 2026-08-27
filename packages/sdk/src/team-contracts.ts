/**
 * Shared contracts for authenticated `/team` CRM surfaces and mutations.
 *
 * Keep these types transport-safe: the Site, API, workers, and regression
 * suites all use them as the common boundary rather than defining subtly
 * different versions of a team principal or mutation result.
 */

export const TEAM_PERMISSION_CATALOG = [
  "access.break_glass",
  "access.manage",
  "ad_spend.write",
  "appointments.read",
  "appointments.update",
  "appointments.override_conflicts",
  "appointment_media.capture",
  "appointment_media.manage",
  "audit.read",
  "audit.export",
  "automation.read",
  "automation.simulate",
  "automation.write",
  "bookings.manage",
  "calls.place",
  "calls.reconcile",
  "contacts.read",
  "contacts.write",
  "contacts.delete",
  "contacts.restore",
  "contacts.purge",
  "contacts.merge",
  "expenses.read",
  "expenses.export",
  "expenses.write",
  "expenses.submit",
  "expenses.approve",
  "properties.read",
  "properties.write",
  "properties.delete",
  "pipeline.read",
  "pipeline.write",
  "messages.read",
  "messages.write",
  "messages.upload",
  "messages.delete",
  "messages.send",
  "messages.export",
  "payments.read",
  "payments.collect",
  "payments.manage",
  "payments.reconcile",
  "policy.read",
  "policy.write",
  "quotes.read",
  "quotes.write",
  "quotes.send",
  "quotes.update",
  "quotes.delete",
  "sales.read",
  "sales.write",
  "sales.reset",
  "sessions.manage_self",
  "outbound.read",
  "outbound.write",
  "outbound.import",
  "partners.read",
  "partners.write",
  "partners.invite",
  "partners.rates",
  "finance.read",
  "financials.read",
  "commissions.read",
  "commissions.manage",
  "commissions.pay",
  "marketing.read",
  "marketing.write",
  "marketing.apply",
  "marketing.publish",
  "outbox.dispatch",
] as const;

export type TeamPermission = (typeof TEAM_PERMISSION_CATALOG)[number];

const TEAM_PERMISSION_SET: ReadonlySet<string> = new Set(
  TEAM_PERMISSION_CATALOG,
);

export function isTeamPermission(value: string): value is TeamPermission {
  return TEAM_PERMISSION_SET.has(value);
}

/**
 * Owner-only human capabilities that Access must never add to a custom role
 * or member. Built-in Owner storage receives these explicitly through
 * provisioning/migrations; a bare legacy wildcard does not acquire them.
 */
export const TEAM_OWNER_ONLY_PERMISSION_CATALOG = [
  "contacts.purge",
  "expenses.approve",
  "financials.read",
  "ad_spend.write",
] as const satisfies readonly TeamPermission[];

const TEAM_OWNER_ONLY_PERMISSION_SET: ReadonlySet<string> = new Set(
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
);

export type TeamOwnerOnlyPermission =
  (typeof TEAM_OWNER_ONLY_PERMISSION_CATALOG)[number];
export type TeamAssignablePermission = Exclude<
  TeamPermission,
  "access.break_glass" | TeamOwnerOnlyPermission | "sessions.manage_self"
>;

/** Permissions an access administrator may assign to roles or members. */
export const TEAM_ASSIGNABLE_PERMISSION_CATALOG: TeamAssignablePermission[] =
  TEAM_PERMISSION_CATALOG.filter(
    (permission): permission is TeamAssignablePermission =>
      permission !== "access.break_glass" &&
      !TEAM_OWNER_ONLY_PERMISSION_SET.has(permission) &&
      permission !== "sessions.manage_self",
  );

const TEAM_ASSIGNABLE_PERMISSION_SET: ReadonlySet<string> = new Set(
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
);

export function isAssignableTeamPermission(
  value: string,
): value is TeamAssignablePermission {
  return TEAM_ASSIGNABLE_PERMISSION_SET.has(value);
}

/**
 * Capabilities owned by a verified person rather than by their CRM job role.
 * They are intentionally not assignable in Access and are still subject to
 * explicit stored denies so the global deny-wins invariant remains true.
 */
export const TEAM_AUTHENTICATED_BASELINE_PERMISSIONS = [
  "sessions.manage_self",
] as const satisfies readonly TeamPermission[];

/**
 * Explicit read-only role seed. The legacy `read` wildcard remains a
 * compatibility input until stored roles are migrated, but new role defaults
 * never depend on its implicit expansion.
 */
export const TEAM_READ_ONLY_PERMISSIONS = [
  "appointments.read",
  "audit.read",
  "automation.read",
  "contacts.read",
  "expenses.read",
  "properties.read",
  "pipeline.read",
  "messages.read",
  "policy.read",
  "quotes.read",
  "sales.read",
  "outbound.read",
  "partners.read",
  "finance.read",
  "commissions.read",
  "marketing.read",
] as const satisfies readonly TeamPermission[];

/**
 * Least-privilege starting points for custom roles in Access.
 *
 * These are templates, not hidden runtime grants. Access administrators must
 * still review the exact permission list and save a custom role explicitly.
 * Keeping the lists in the transport-safe SDK prevents the Access UI and the
 * API's built-in role provisioning from drifting apart.
 */
export const TEAM_ROLE_PERMISSION_TEMPLATES = {
  office: {
    label: "Office operations",
    description:
      "Coordinate leads, conversations, schedules, quotes, payments, expenses, and day-to-day sales work.",
    permissions: [
      "messages.send",
      "messages.read",
      "messages.write",
      "messages.upload",
      "messages.delete",
      "policy.read",
      "policy.write",
      "bookings.manage",
      "calls.place",
      "calls.reconcile",
      "automation.read",
      "automation.simulate",
      "automation.write",
      "audit.read",
      "appointments.read",
      "appointments.update",
      "appointment_media.capture",
      "appointment_media.manage",
      "payments.read",
      "payments.collect",
      "quotes.read",
      "quotes.write",
      "quotes.send",
      "quotes.update",
      "quotes.delete",
      "expenses.read",
      "expenses.export",
      "expenses.write",
      "expenses.submit",
      "contacts.read",
      "contacts.write",
      "contacts.delete",
      "properties.read",
      "properties.write",
      "properties.delete",
      "pipeline.read",
      "pipeline.write",
      "sales.read",
      "sales.write",
      "outbound.read",
      "outbound.write",
      "outbound.import",
    ],
  },
  sales: {
    label: "Sales representative",
    description:
      "Work assigned leads from conversation through quote, booking, collection, pipeline, and outbound follow-up.",
    permissions: [
      "messages.read",
      "messages.write",
      "messages.upload",
      "messages.delete",
      "messages.send",
      "appointments.read",
      "appointments.update",
      "appointment_media.capture",
      "appointment_media.manage",
      "payments.read",
      "payments.collect",
      "bookings.manage",
      "calls.place",
      "quotes.read",
      "quotes.write",
      "quotes.send",
      "quotes.update",
      "contacts.read",
      "contacts.write",
      "properties.read",
      "properties.write",
      "pipeline.read",
      "pipeline.write",
      "sales.read",
      "sales.write",
      "outbound.read",
      "outbound.write",
      "outbound.import",
      "automation.simulate",
    ],
  },
  crew: {
    label: "Crew member",
    description:
      "Handle assigned jobs, job media, customer calls, payment collection, and field expenses.",
    permissions: [
      "calls.place",
      "messages.read",
      "appointments.read",
      "appointments.update",
      "appointment_media.capture",
      "payments.read",
      "payments.collect",
      "expenses.submit",
    ],
  },
  read_only: {
    label: "Read only",
    description:
      "Review CRM records and reports without permission to send, edit, delete, pay, publish, or administer.",
    permissions: TEAM_READ_ONLY_PERMISSIONS,
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      label: string;
      description: string;
      permissions: readonly TeamPermission[];
    }
  >
>;

export type TeamRolePermissionTemplateId =
  keyof typeof TEAM_ROLE_PERMISSION_TEMPLATES;

// Stored custom grants may contain forward-compatible values during rolling
// deployments, so principals keep a string-shaped permission transport type.
export type Permission = string;

export type TeamPrincipal = {
  memberId: string;
  sessionId: string;
  roleSlug: string | null;
  permissions: Permission[];
  label: string;
  authMethod: "team_session" | "break_glass";
};

export type TeamSurfaceGroup =
  | "daily"
  | "sales"
  | "marketing"
  | "owner"
  | "admin"
  | "tools"
  | "personal";

export type TeamSurfaceDefinition = {
  id: string;
  canonicalPath: string;
  legacyTabs: readonly string[];
  group: TeamSurfaceGroup;
  label: string;
  requiredPermissions: readonly TeamPermission[];
  subviews: readonly string[];
};

export type ActionRisk =
  | "read"
  | "normal"
  | "external"
  | "financial"
  | "destructive";

export type ActionPolicy = {
  principalTypes: ("human" | "service")[];
  requiredPermissions: TeamPermission[];
  risk: ActionRisk;
  requiresIdempotency: boolean;
  auditAction: string;
};

export type MutationReceipt = {
  operationId: string;
  correlationId: string;
  actorId: string;
  committedAt: string;
  auditEventId?: string;
  entityType?: string;
  entityId?: string;
  version?: string | number;
  providerOperationId?: string;
};

export type MutationErrorCode =
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "invalid"
  | "rate_limited"
  | "timeout"
  | "provider_failed"
  | "internal";

export type MutationResult<T> =
  | { ok: true; data: T; receipt: MutationReceipt }
  | {
      ok: false;
      code: MutationErrorCode;
      message: string;
      retryable: boolean;
      fieldErrors?: Record<string, string>;
    };
