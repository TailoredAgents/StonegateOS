/**
 * Shared contracts for authenticated `/team` CRM surfaces and mutations.
 *
 * Keep these types transport-safe: the Site, API, workers, and regression
 * suites all use them as the common boundary rather than defining subtly
 * different versions of a team principal or mutation result.
 */
export declare const TEAM_PERMISSION_CATALOG: readonly [
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
  "partners.accounts.read",
  "partners.applications.read",
  "partners.joins.read",
  "partners.people.read",
  "partners.memberships.read",
  "partners.invitations.read",
  "partners.domains.read",
  "partners.security.read",
  "partners.quarantine.read",
  "partners.preview.read",
  "partners.commercial.read",
  "partners.billing_disputes.read",
  "partners.cancellation_requests.read",
  "partners.change_requests.read",
  "partners.relationships.manage",
  "partners.accounts.manage",
  "partners.accounts.lifecycle",
  "partners.applications.review",
  "partners.applications.approve",
  "partners.applications.decline",
  "partners.joins.review",
  "partners.joins.approve",
  "partners.joins.decline",
  "partners.invitations.send",
  "partners.invitations.revoke",
  "partners.memberships.manage",
  "partners.memberships.suspend",
  "partners.memberships.migration.review",
  "partners.domains.manage",
  "partners.domains.verify",
  "partners.domains.revoke",
  "partners.security.sessions.revoke",
  "partners.quarantine.contain",
  "partners.reconciliation.manage",
  "partners.commercial.manage",
  "partners.billing_disputes.decide",
  "partners.cancellation_requests.decide",
  "partners.change_requests.decide",
  "partners.identities.disable",
  "partners.memberships.recover_admin",
  "partners.domains.override",
  "partners.accounts.merge",
  "partners.accounts.close",
  "partners.quarantine.release",
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
];
export type TeamPermission = (typeof TEAM_PERMISSION_CATALOG)[number];
/**
 * Exact expansion used while broad, historical partner grants remain stored.
 *
 * Expansion is intentionally one-way: a narrow V1 grant never implies access
 * to a broad legacy route. This lets administrators migrate roles without a
 * temporary privilege increase and keeps legacy denies meaningful.
 */
export declare const TEAM_PARTNER_LEGACY_PERMISSION_COMPATIBILITY: {
  readonly "partners.read": readonly [
    "partners.accounts.read",
    "partners.applications.read",
    "partners.joins.read",
    "partners.people.read",
    "partners.memberships.read",
    "partners.invitations.read",
    "partners.domains.read",
    "partners.security.read",
    "partners.quarantine.read",
    "partners.preview.read",
    "partners.commercial.read",
    "partners.billing_disputes.read",
    "partners.cancellation_requests.read",
    "partners.change_requests.read",
  ];
  readonly "partners.write": readonly [
    "partners.relationships.manage",
    "partners.accounts.manage",
    "partners.domains.manage",
    "partners.accounts.lifecycle",
    "partners.quarantine.contain",
    "partners.reconciliation.manage",
    "partners.cancellation_requests.decide",
    "partners.change_requests.decide",
  ];
  readonly "partners.invite": readonly [
    "partners.applications.review",
    "partners.applications.approve",
    "partners.applications.decline",
    "partners.joins.review",
    "partners.joins.approve",
    "partners.joins.decline",
    "partners.invitations.send",
    "partners.invitations.revoke",
    "partners.memberships.manage",
    "partners.memberships.suspend",
    "partners.memberships.migration.review",
    "partners.domains.verify",
    "partners.domains.revoke",
    "partners.reconciliation.manage",
  ];
  readonly "partners.rates": readonly [
    "partners.commercial.read",
    "partners.commercial.manage",
    "partners.billing_disputes.read",
    "partners.billing_disputes.decide",
  ];
};
/** Stored-role inputs accepted at runtime but unavailable for new grants. */
export declare const TEAM_PARTNER_LEGACY_PERMISSION_CATALOG: readonly [
  "partners.read",
  "partners.write",
  "partners.invite",
  "partners.rates",
];
export declare function isTeamPermission(
  value: string,
): value is TeamPermission;
/**
 * Owner-only human capabilities that Access must never add to a custom role
 * or member. Built-in Owner storage receives these explicitly through
 * provisioning/migrations; a bare legacy wildcard does not acquire them.
 */
export declare const TEAM_OWNER_ONLY_PERMISSION_CATALOG: readonly [
  "contacts.purge",
  "expenses.approve",
  "financials.read",
  "ad_spend.write",
  "partners.identities.disable",
  "partners.memberships.recover_admin",
  "partners.domains.override",
  "partners.accounts.merge",
  "partners.accounts.close",
  "partners.quarantine.release",
];
export type TeamOwnerOnlyPermission =
  (typeof TEAM_OWNER_ONLY_PERMISSION_CATALOG)[number];
export type TeamAssignablePermission = Exclude<
  TeamPermission,
  | "access.break_glass"
  | TeamOwnerOnlyPermission
  | "sessions.manage_self"
  | (typeof TEAM_PARTNER_LEGACY_PERMISSION_CATALOG)[number]
>;
/** Permissions an access administrator may assign to roles or members. */
export declare const TEAM_ASSIGNABLE_PERMISSION_CATALOG: TeamAssignablePermission[];
export declare function isAssignableTeamPermission(
  value: string,
): value is TeamAssignablePermission;
/**
 * Capabilities owned by a verified person rather than by their CRM job role.
 * They are intentionally not assignable in Access and are still subject to
 * explicit stored denies so the global deny-wins invariant remains true.
 */
export declare const TEAM_AUTHENTICATED_BASELINE_PERMISSIONS: readonly [
  "sessions.manage_self",
];
/**
 * Explicit read-only role seed. The legacy `read` wildcard remains a
 * compatibility input until stored roles are migrated, but new role defaults
 * never depend on its implicit expansion.
 */
export declare const TEAM_READ_ONLY_PERMISSIONS: readonly [
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
  "partners.accounts.read",
  "partners.applications.read",
  "partners.joins.read",
  "partners.people.read",
  "partners.memberships.read",
  "partners.invitations.read",
  "partners.domains.read",
  "partners.security.read",
  "partners.quarantine.read",
  "partners.preview.read",
  "partners.commercial.read",
  "partners.billing_disputes.read",
  "partners.cancellation_requests.read",
  "partners.change_requests.read",
  "finance.read",
  "commissions.read",
  "marketing.read",
];
/**
 * Least-privilege starting points for custom roles in Access.
 *
 * These are templates, not hidden runtime grants. Access administrators must
 * still review the exact permission list and save a custom role explicitly.
 * Keeping the lists in the transport-safe SDK prevents the Access UI and the
 * API's built-in role provisioning from drifting apart.
 */
export declare const TEAM_ROLE_PERMISSION_TEMPLATES: {
  readonly office: {
    readonly label: "Office operations";
    readonly description: "Coordinate leads, conversations, schedules, quotes, payments, expenses, and day-to-day sales work.";
    readonly permissions: readonly [
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
    ];
  };
  readonly sales: {
    readonly label: "Sales representative";
    readonly description: "Work assigned leads from conversation through quote, booking, collection, pipeline, and outbound follow-up.";
    readonly permissions: readonly [
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
    ];
  };
  readonly crew: {
    readonly label: "Crew member";
    readonly description: "Handle assigned jobs, job media, customer calls, payment collection, and field expenses.";
    readonly permissions: readonly [
      "calls.place",
      "messages.read",
      "appointments.read",
      "appointments.update",
      "appointment_media.capture",
      "payments.read",
      "payments.collect",
      "expenses.submit",
    ];
  };
  readonly read_only: {
    readonly label: "Read only";
    readonly description: "Review CRM records and reports without permission to send, edit, delete, pay, publish, or administer.";
    readonly permissions: readonly [
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
      "partners.accounts.read",
      "partners.applications.read",
      "partners.joins.read",
      "partners.people.read",
      "partners.memberships.read",
      "partners.invitations.read",
      "partners.domains.read",
      "partners.security.read",
      "partners.quarantine.read",
      "partners.preview.read",
      "partners.commercial.read",
      "partners.billing_disputes.read",
      "partners.cancellation_requests.read",
      "partners.change_requests.read",
      "finance.read",
      "commissions.read",
      "marketing.read",
    ];
  };
};
export type TeamRolePermissionTemplateId =
  keyof typeof TEAM_ROLE_PERMISSION_TEMPLATES;
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
  /**
   * Maximum age of the human authentication ceremony for sensitive actions.
   * This is intentionally policy data rather than a route-local check so the
   * authorization decision and the resulting audit receipt cannot drift.
   */
  maxAuthenticationAgeSeconds?: number;
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
  | {
      ok: true;
      data: T;
      receipt: MutationReceipt;
    }
  | {
      ok: false;
      code: MutationErrorCode;
      message: string;
      retryable: boolean;
      fieldErrors?: Record<string, string>;
    };
//# sourceMappingURL=team-contracts.d.ts.map
