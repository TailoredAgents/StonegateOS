import {
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  TEAM_ROLE_PERMISSION_TEMPLATES,
  type TeamRolePermissionTemplateId,
} from "@myst-os/sdk";

const PERMISSION_GROUP_LABELS: Readonly<Record<string, string>> = {
  access: "Access and team",
  ad_spend: "Daily ad spend",
  appointments: "Appointments",
  appointment_media: "Appointment media",
  audit: "Audit",
  automation: "Automation",
  bookings: "Bookings",
  calls: "Calling",
  commissions: "Commissions",
  contacts: "Contacts",
  expenses: "Expenses",
  finance: "Finance",
  financials: "Expense overview",
  marketing: "Marketing",
  messages: "Messaging",
  outbox: "Provider delivery",
  outbound: "Outbound sales",
  partners: "Partners",
  payments: "Payments",
  pipeline: "Pipeline",
  policy: "Policy",
  properties: "Properties",
  quotes: "Quotes",
  sales: "Sales",
};

const PERMISSION_OBJECT_LABELS: Readonly<Record<string, string>> = {
  access: "team access",
  ad_spend: "daily ad spend",
  appointments: "appointments",
  appointment_media: "appointment media",
  audit: "audit history",
  automation: "automation",
  bookings: "bookings",
  calls: "calls",
  commissions: "commission payouts",
  contacts: "contacts",
  expenses: "expenses",
  finance: "financial reports",
  financials: "expense financial overview",
  marketing: "marketing",
  messages: "conversations",
  outbox: "provider operations",
  outbound: "outbound sales",
  partners: "partners",
  payments: "payments",
  pipeline: "the sales pipeline",
  policy: "business policies",
  properties: "properties",
  quotes: "quotes",
  sales: "sales work",
};

const PERMISSION_ACTION_LABELS: Readonly<Record<string, string>> = {
  apply: "Apply changes to",
  capture: "Capture",
  collect: "Collect",
  delete: "Delete",
  dispatch: "Dispatch",
  export: "Export",
  import: "Import",
  invite: "Invite users for",
  manage: "Manage",
  merge: "Merge",
  override_conflicts: "Override conflicts for",
  pay: "Mark paid",
  place: "Place",
  publish: "Publish",
  rates: "Set rates for",
  read: "View",
  reconcile: "Reconcile",
  reset: "Reset",
  restore: "Restore",
  send: "Send",
  simulate: "Simulate",
  update: "Update",
  upload: "Upload files to",
  write: "Create and edit",
};

const PERMISSION_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "ad_spend.write": "Enter daily ad spend",
  "appointment_media.capture": "Capture appointment photos and media",
  "appointment_media.manage": "Manage appointment photos and media",
  "appointments.override_conflicts": "Override appointment conflicts",
  "audit.export": "Export redacted audit history",
  "automation.write": "Change automation controls",
  "calls.reconcile": "Resolve uncertain call outcomes",
  "commissions.pay": "Mark commission payouts paid",
  "contacts.merge": "Merge duplicate contacts",
  "expenses.approve": "Approve submitted expenses",
  "expenses.submit": "Submit expenses for review",
  "financials.read": "View expense financial overview",
  "messages.export": "Export customer conversations",
  "messages.delete": "Delete conversation messages",
  "messages.send": "Send customer messages",
  "messages.upload": "Upload conversation attachments",
  "marketing.apply": "Apply advertising changes",
  "marketing.publish": "Publish marketing content",
  "outbound.import": "Import outbound accounts",
  "outbox.dispatch": "Dispatch queued provider operations",
  "partners.invite": "Invite partner portal users",
  "partners.rates": "Set partner rates",
  "partners.accounts.read": "View partner companies",
  "partners.applications.read": "View partner access applications",
  "partners.joins.read": "View partner company join requests",
  "partners.people.read": "View registered partner identities",
  "partners.memberships.read": "View partner company memberships",
  "partners.invitations.read": "View partner account invitations",
  "partners.security.read": "View partner security posture",
  "partners.quarantine.read": "View quarantined partner records",
  "partners.preview.read": "Open read-only partner previews",
  "partners.commercial.read": "View partner commercial configuration",
  "partners.billing_disputes.read": "View partner billing-dispute requests",
  "partners.cancellation_requests.read":
    "View partner cancellation-review requests",
  "partners.change_requests.read": "View partner job change requests",
  "partners.relationships.manage": "Manage partner CRM relationships",
  "partners.accounts.manage": "Manage partner company profiles",
  "partners.accounts.lifecycle": "Change partner account lifecycle state",
  "partners.applications.review": "Request partner application information",
  "partners.applications.approve": "Approve partner access applications",
  "partners.applications.decline": "Decline partner access applications",
  "partners.joins.review": "Request join-request information",
  "partners.joins.approve": "Approve partner company join requests",
  "partners.joins.decline": "Decline partner company join requests",
  "partners.invitations.send": "Send partner account invitations",
  "partners.invitations.revoke": "Revoke partner account invitations",
  "partners.memberships.manage": "Manage partner membership roles and scopes",
  "partners.memberships.suspend": "Suspend partner account memberships",
  "partners.security.sessions.revoke": "Revoke partner sessions",
  "partners.quarantine.contain": "Quarantine unsafe partner records",
  "partners.reconciliation.manage": "Resolve partner delivery reconciliation",
  "partners.commercial.manage": "Manage partner commercial configuration",
  "partners.billing_disputes.decide":
    "Classify partner billing-dispute requests",
  "partners.cancellation_requests.decide":
    "Approve or decline partner cancellation requests",
  "partners.change_requests.decide": "Resolve partner job change requests",
  "payments.manage": "Manage payment records",
  "payments.reconcile": "Resolve payment mismatches",
  "sales.reset": "Reset sales coaching state",
};

const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  "access.manage",
  "ad_spend.write",
  "appointments.override_conflicts",
  "audit.export",
  "automation.write",
  "calls.reconcile",
  "commissions.manage",
  "commissions.pay",
  "contacts.delete",
  "contacts.merge",
  "expenses.export",
  "expenses.approve",
  "expenses.submit",
  "financials.read",
  "marketing.apply",
  "marketing.publish",
  "messages.delete",
  "messages.export",
  "messages.send",
  "outbound.import",
  "outbox.dispatch",
  "partners.invite",
  "partners.rates",
  "partners.accounts.lifecycle",
  "partners.accounts.manage",
  "partners.applications.approve",
  "partners.applications.decline",
  "partners.applications.review",
  "partners.commercial.manage",
  "partners.billing_disputes.decide",
  "partners.cancellation_requests.decide",
  "partners.change_requests.decide",
  "partners.invitations.revoke",
  "partners.invitations.send",
  "partners.joins.approve",
  "partners.joins.decline",
  "partners.joins.review",
  "partners.memberships.manage",
  "partners.memberships.suspend",
  "partners.quarantine.contain",
  "partners.reconciliation.manage",
  "partners.relationships.manage",
  "partners.security.sessions.revoke",
  "payments.collect",
  "payments.manage",
  "payments.reconcile",
  "properties.delete",
  "quotes.delete",
  "quotes.send",
  "sales.reset",
]);

export const ACCESS_ROLE_TEMPLATE_IDS = [
  "office",
  "sales",
  "crew",
  "read_only",
] as const satisfies readonly TeamRolePermissionTemplateId[];

export const ACCESS_ROLE_TEMPLATE_OPTIONS = ACCESS_ROLE_TEMPLATE_IDS.map(
  (id) => ({ id, ...TEAM_ROLE_PERMISSION_TEMPLATES[id] }),
);

const ASSIGNABLE_PERMISSION_SET: ReadonlySet<string> = new Set(
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
);

export const ACCESS_PERMISSION_GROUPS = Array.from(
  [...TEAM_ASSIGNABLE_PERMISSION_CATALOG]
    .sort((a, b) => a.localeCompare(b))
    .reduce((groups, permission) => {
      const group = permission.split(".", 1)[0] ?? "other";
      const current = groups.get(group) ?? [];
      current.push(permission);
      groups.set(group, current);
      return groups;
    }, new Map<string, string[]>()),
).map(([id, permissions]) => ({
  id,
  label: PERMISSION_GROUP_LABELS[id] ?? id,
  permissions,
}));

export function getAccessRoleTemplate(
  value: string,
): (typeof ACCESS_ROLE_TEMPLATE_OPTIONS)[number] | null {
  return (
    ACCESS_ROLE_TEMPLATE_OPTIONS.find((template) => template.id === value) ??
    null
  );
}

export function normalizeAccessRolePermissionSelection(
  values: Iterable<string>,
): string[] {
  return Array.from(
    new Set(
      Array.from(values, (value) => value.trim()).filter((value) =>
        ASSIGNABLE_PERMISSION_SET.has(value),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export function describeAccessPermission(permission: string): {
  label: string;
  sensitive: boolean;
} {
  const override = PERMISSION_LABEL_OVERRIDES[permission];
  if (override) {
    return {
      label: override,
      sensitive: SENSITIVE_PERMISSIONS.has(permission),
    };
  }
  const [group = "", action = ""] = permission.split(".", 2);
  const objectLabel =
    PERMISSION_OBJECT_LABELS[group] ?? group.replaceAll("_", " ");
  const actionLabel =
    PERMISSION_ACTION_LABELS[action] ?? action.replaceAll("_", " ");
  const label = `${actionLabel} ${objectLabel}`.trim();
  return {
    label: label
      ? `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`
      : permission,
    sensitive: SENSITIVE_PERMISSIONS.has(permission),
  };
}
