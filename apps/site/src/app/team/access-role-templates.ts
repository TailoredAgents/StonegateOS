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
