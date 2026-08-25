import React from "react";
import { randomUUID } from "node:crypto";
import { TEAM_ASSIGNABLE_PERMISSION_CATALOG } from "@myst-os/sdk";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import {
  parseAccessRolesPayload,
  type AccessRoleRecord,
} from "../access-role-page";
import { callAdminApiAs } from "../lib/api";
import {
  ACCESS_PERMISSION_GROUPS,
  describeAccessPermission,
} from "../access-role-templates";
import { RoleCreateForm } from "./RoleCreateForm";
import { RoleEditForm } from "./RoleEditForm";
import { AccessSessionRefreshButton } from "./AccessSessionRefreshButton";

type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  emailMigrationStatus?: "ready" | "needs_review" | "none";
  phone: string | null;
  phoneMigrationStatus?: "ready" | "needs_review" | "none";
  defaultCrewSplitBps: number | null;
  fixedCrewJobRateBps: number | null;
  permissionsGrant: string[];
  permissionsDeny: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  role: {
    id: string;
    name: string | null;
    slug: string | null;
  } | null;
};

type TeamSession = {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string | null;
  authMethod: "team_session" | "break_glass";
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

type ResourceResult<T> = { ok: true; data: T } | { ok: false; error: string };

const PERMISSION_OPTIONS = [...TEAM_ASSIGNABLE_PERMISSION_CATALOG].sort(
  (a, b) => a.localeCompare(b),
);
const PERMISSION_OPTION_SET = new Set<string>(PERMISSION_OPTIONS);

function formatSessionTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString();
}

function sessionStatusClasses(status: TeamSession["status"]): string {
  if (status === "active") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "revoked") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function effectivePermissionsFor(
  member: TeamMember,
  roles: AccessRoleRecord[],
): string[] {
  const rolePermissions =
    roles.find((role) => role.id === member.role?.id)?.permissions ?? [];
  const effective = new Set<string>();
  if (rolePermissions.includes("*")) {
    for (const permission of PERMISSION_OPTIONS) effective.add(permission);
  } else {
    for (const permission of rolePermissions) {
      if (PERMISSION_OPTION_SET.has(permission)) effective.add(permission);
    }
  }
  if (member.permissionsGrant.includes("*")) {
    for (const permission of PERMISSION_OPTIONS) effective.add(permission);
  } else {
    for (const permission of member.permissionsGrant) {
      if (PERMISSION_OPTION_SET.has(permission)) effective.add(permission);
    }
  }
  if (member.permissionsDeny.includes("*")) return [];
  for (const permission of member.permissionsDeny) effective.delete(permission);
  return [...effective].sort((a, b) => a.localeCompare(b));
}

function permissionPresentation(permission: string): {
  label: string;
  sensitive: boolean;
  supported: boolean;
} {
  if (permission === "*") {
    return {
      label: "All assignable permissions",
      sensitive: true,
      supported: true,
    };
  }
  if (!PERMISSION_OPTION_SET.has(permission)) {
    return {
      label: "Unsupported legacy permission",
      sensitive: true,
      supported: false,
    };
  }
  return { ...describeAccessPermission(permission), supported: true };
}

function PermissionSummary({
  permission,
}: {
  permission: string;
}): React.ReactElement {
  const presentation = permissionPresentation(permission);
  return (
    <span
      className={`inline-flex max-w-full flex-col rounded-xl border px-2.5 py-1.5 ${
        presentation.supported
          ? "border-[color:var(--team-border)] bg-[color:var(--team-surface)]"
          : "border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)]"
      }`}
    >
      <span className="flex flex-wrap items-center gap-1.5 font-semibold text-[color:var(--team-text)]">
        {presentation.label}
        {presentation.sensitive ? (
          <span className="text-[9px] uppercase tracking-wide text-[color:var(--team-warning-text)]">
            Sensitive
          </span>
        ) : null}
      </span>
      <code className="mt-0.5 break-all text-[9px] text-[color:var(--team-text-soft)]">
        {permission}
      </code>
    </span>
  );
}

function PermissionOverrideRow({
  denied,
  granted,
  permission,
}: {
  denied: boolean;
  granted: boolean;
  permission: string;
}): React.ReactElement {
  const presentation = describeAccessPermission(permission);
  return (
    <div className="grid min-h-[60px] gap-2 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_88px_88px] sm:items-center">
      <span className="min-w-0 text-xs text-[color:var(--team-text-muted)]">
        <span className="flex flex-wrap items-center gap-1.5 font-semibold text-[color:var(--team-text)]">
          {presentation.label}
          {presentation.sensitive ? (
            <span className="rounded-full border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] px-2 py-0.5 text-[9px] uppercase tracking-wide text-[color:var(--team-warning-text)]">
              Sensitive
            </span>
          ) : null}
        </span>
        <code className="mt-0.5 block break-all text-[9px] text-[color:var(--team-text-soft)]">
          {permission}
        </code>
      </span>
      <div className="grid grid-cols-2 gap-2 sm:contents">
        <label className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-[color:var(--team-border)] px-2 text-xs font-semibold text-[color:var(--team-text-muted)] hover:border-[color:var(--team-focus-ring)]">
          <input
            type="checkbox"
            name="permissionsGrant"
            value={permission}
            defaultChecked={granted}
            aria-label={`Grant ${presentation.label}`}
            className="h-5 w-5 rounded border-[color:var(--team-border-strong)]"
          />
          Grant
        </label>
        <label className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-[color:var(--team-border)] px-2 text-xs font-semibold text-[color:var(--team-text-muted)] hover:border-[color:var(--team-danger-border)]">
          <input
            type="checkbox"
            name="permissionsDeny"
            value={permission}
            defaultChecked={denied}
            aria-label={`Deny ${presentation.label}`}
            className="h-5 w-5 rounded border-[color:var(--team-border-strong)]"
          />
          Deny
        </label>
      </div>
      {granted && denied ? (
        <p
          className="text-[10px] font-semibold text-[color:var(--team-warning-text)] sm:col-span-3"
          role="status"
        >
          Both are currently stored; Deny takes priority.
        </p>
      ) : null}
    </div>
  );
}

export async function AccessSection(): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  let roles: AccessRoleRecord[] = [];
  let members: TeamMember[] = [];
  let defaultAssigneeMemberId: string | null = null;
  let sessions: TeamSession[] = [];
  let sessionsTotal = 0;
  let sessionsTruncated = false;

  const loadResource = async <T,>(
    path: string,
    label: string,
  ): Promise<ResourceResult<T>> => {
    try {
      const response = await callAdminApiAs(principal, path);
      if (!response.ok) {
        return {
          ok: false,
          error: `${label} could not be loaded (HTTP ${response.status}).`,
        };
      }
      return { ok: true, data: (await response.json()) as T };
    } catch {
      return { ok: false, error: `${label} could not be reached.` };
    }
  };

  const [rolesResult, membersResult, routingResult, sessionsResult] =
    await Promise.all([
      loadResource<unknown>("/api/admin/roles", "Roles"),
      loadResource<{ members?: TeamMember[] }>(
        "/api/admin/team/members",
        "Members",
      ),
      loadResource<{ defaultAssigneeMemberId?: string | null }>(
        "/api/admin/sales/settings",
        "Lead routing",
      ),
      loadResource<{
        sessions?: TeamSession[];
        total?: number;
        truncated?: boolean;
      }>("/api/admin/team/sessions", "Sessions"),
    ]);

  let rolesError: string | null = null;
  const parsedRoles = rolesResult.ok
    ? parseAccessRolesPayload(rolesResult.data)
    : null;
  if (parsedRoles) {
    roles = parsedRoles;
  } else {
    rolesError = rolesResult.ok
      ? "Roles returned an incomplete response."
      : rolesResult.error;
  }

  let membersError: string | null = null;
  if (membersResult.ok && Array.isArray(membersResult.data.members)) {
    members = membersResult.data.members.map((member) => ({
      ...member,
      fixedCrewJobRateBps:
        typeof member.fixedCrewJobRateBps === "number"
          ? member.fixedCrewJobRateBps
          : null,
      permissionsGrant: Array.isArray(member.permissionsGrant)
        ? member.permissionsGrant
        : [],
      permissionsDeny: Array.isArray(member.permissionsDeny)
        ? member.permissionsDeny
        : [],
    }));
  } else {
    membersError = membersResult.ok
      ? "Members returned an incomplete response."
      : membersResult.error;
  }

  let routingError: string | null = null;
  if (routingResult.ok) {
    const value = routingResult.data.defaultAssigneeMemberId;
    defaultAssigneeMemberId =
      typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
  } else {
    routingError = routingResult.error;
  }

  let sessionsError: string | null = null;
  if (sessionsResult.ok && Array.isArray(sessionsResult.data.sessions)) {
    sessions = sessionsResult.data.sessions;
    sessionsTotal = Number.isFinite(sessionsResult.data.total)
      ? Number(sessionsResult.data.total)
      : sessions.length;
    sessionsTruncated = sessionsResult.data.truncated === true;
  } else {
    sessionsError = sessionsResult.ok
      ? "Sessions returned an incomplete response."
      : sessionsResult.error;
  }

  const supportedPermissions = new Set<string>(
    TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  );

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Access Control</h2>
        <p className="mt-1 text-sm text-slate-600">
          Assign roles, permissions, and active access for the team.
        </p>
      </header>

      <nav
        aria-label="Access views"
        className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2"
      >
        {[
          ["members", "Members"],
          ["roles", "Roles"],
          ["routing", "Routing"],
          ["sessions", "Sessions"],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        <div
          id="routing"
          className="scroll-mt-24 rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur"
        >
          <h3 className="text-base font-semibold text-slate-900">
            Lead routing
          </h3>
          <p className="text-xs text-slate-500">
            Choose who new leads are assigned to by default.
          </p>
          {routingError || membersError ? (
            <p
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="alert"
            >
              {routingError ?? membersError} The current default is unknown and
              cannot be changed safely.
            </p>
          ) : null}
          <form
            action="/api/team/access/sales-settings"
            method="post"
            className="mt-4 flex flex-wrap items-center gap-3"
          >
            <fieldset
              disabled={Boolean(routingError || membersError)}
              className="contents"
            >
              <select
                name="defaultAssigneeMemberId"
                defaultValue={defaultAssigneeMemberId ?? ""}
                className="w-full rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 sm:min-w-[240px] sm:w-auto"
              >
                <option value="">Auto (first active team member)</option>
                {members
                  .filter((member) => member.active)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save default
              </SubmitButton>
            </fieldset>
          </form>
        </div>

        <div
          id="roles"
          className="scroll-mt-24 rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur"
        >
          <h3 className="text-base font-semibold text-slate-900">Roles</h3>
          <p className="text-xs text-slate-500">
            Define what each role can do in the console.
          </p>
          {rolesError ? (
            <p
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="alert"
            >
              {rolesError} This is not an empty role list; editing is disabled
              until the current baseline reloads.
            </p>
          ) : null}
          <div className="mt-4 space-y-3">
            {roles.map((role) => (
              <div
                key={role.id}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-600"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">
                    {role.name}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-400">
                    {role.slug}
                  </span>
                </div>
                {role.permissions.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {role.permissions.map((permission) => (
                      <PermissionSummary
                        key={`${role.id}-${permission}`}
                        permission={permission}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-500">
                    No permissions set
                  </p>
                )}
                <details className="mt-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2">
                  <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-semibold text-[color:var(--team-link)]">
                    Edit role and exact permissions
                  </summary>
                  <RoleEditForm role={role} />
                </details>
              </div>
            ))}
          </div>
          <RoleCreateForm
            disabled={Boolean(rolesError)}
            idempotencyKey={`access-role-create:${randomUUID()}`}
          />
        </div>

        <div
          id="members"
          className="scroll-mt-24 rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur"
        >
          <h3 className="text-base font-semibold text-slate-900">
            Team members
          </h3>
          <p className="text-xs text-slate-500">
            Assign a role and mark active access.
          </p>
          {membersError ? (
            <p
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="alert"
            >
              {membersError} This is not an empty member list; member changes
              are disabled until the current records reload.
            </p>
          ) : null}
          <div className="mt-4 space-y-3">
            {members.map((member) => (
              <div
                key={member.id}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-600"
              >
                <form
                  action={`/api/team/access/members/${member.id}`}
                  method="post"
                  className="space-y-3"
                >
                  <input type="hidden" name="memberId" value={member.id} />
                  <input
                    type="hidden"
                    name="expectedUpdatedAt"
                    value={member.updatedAt}
                  />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`access-member-update:${member.id}:${member.updatedAt}`}
                  />
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="w-full flex-1 sm:min-w-[220px]">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Name
                          </span>
                          <input
                            name="name"
                            defaultValue={member.name}
                            required
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Email
                          </span>
                          <input
                            name="email"
                            type="email"
                            defaultValue={member.email ?? ""}
                            placeholder="devon@stonegatejunkremoval.com"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                          />
                        </label>
                        {member.emailMigrationStatus === "needs_review" ? (
                          <p
                            className="text-[11px] text-amber-700 sm:col-span-2"
                            role="status"
                          >
                            This email is shared by multiple legacy members, so
                            email login is disabled. Give each affected member a
                            unique email, or clear the address, before login.
                          </p>
                        ) : null}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="font-medium text-slate-600">ID:</span>
                        <code className="rounded bg-white/70 px-2 py-0.5">
                          {member.id}
                        </code>
                        <CopyButton value={member.id} label="Copy" />
                      </div>
                      <details className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
                          Effective access (
                          {effectivePermissionsFor(member, roles).length})
                        </summary>
                        <p className="mt-2 text-[11px] text-slate-500">
                          Role and individual grants combined, with every deny
                          removed. Deny always wins.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {effectivePermissionsFor(member, roles).length ? (
                            effectivePermissionsFor(member, roles).map(
                              (permission) => (
                                <PermissionSummary
                                  key={`effective-${member.id}-${permission}`}
                                  permission={permission}
                                />
                              ),
                            )
                          ) : (
                            <span className="text-[11px] font-semibold text-rose-700">
                              No effective permissions
                            </span>
                          )}
                        </div>
                      </details>
                    </div>
                    <label className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        name="active"
                        defaultChecked={member.active}
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      Active
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      name="roleId"
                      defaultValue={member.role?.id ?? ""}
                      disabled={Boolean(rolesError)}
                      className="w-full rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-700 sm:w-auto"
                    >
                      <option value="">No role</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    <input
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      defaultValue={member.phone ?? ""}
                      placeholder="SMS phone (US), e.g. 6785551234"
                      className="w-full flex-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 sm:min-w-[240px]"
                    />
                    {member.phoneMigrationStatus === "needs_review" ? (
                      <p
                        className="w-full text-[11px] text-amber-700"
                        role="status"
                      >
                        The legacy phone could not be migrated safely. Enter and
                        save a unique phone before using phone login.
                      </p>
                    ) : null}
                    <input
                      name="defaultCrewSplitPercent"
                      defaultValue={
                        member.defaultCrewSplitBps !== null
                          ? String(member.defaultCrewSplitBps / 100)
                          : ""
                      }
                      placeholder="Crew split % (e.g. 50)"
                      inputMode="decimal"
                      className="w-full rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 sm:w-[170px]"
                    />
                    <input
                      name="fixedCrewJobRatePercent"
                      defaultValue={
                        member.fixedCrewJobRateBps !== null
                          ? String(member.fixedCrewJobRateBps / 100)
                          : ""
                      }
                      placeholder="Guaranteed job % (e.g. 10)"
                      inputMode="decimal"
                      className="w-full rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 sm:w-[200px]"
                    />
                    <SubmitButton
                      className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                      pendingLabel="Saving..."
                    >
                      Update
                    </SubmitButton>
                  </div>

                  {PERMISSION_OPTIONS.length ? (
                    <details className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3">
                      <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
                        Individual permission overrides
                      </summary>
                      <p className="mt-2 text-[11px] text-slate-500">
                        Role permissions are the baseline. Grants add
                        permissions, denies remove them (deny wins).
                      </p>
                      {[
                        ...member.permissionsGrant,
                        ...member.permissionsDeny,
                      ].some(
                        (permission) => !supportedPermissions.has(permission),
                      ) ? (
                        <p
                          className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
                          role="status"
                        >
                          This member has legacy permission values that are not
                          supported by the current catalog. Saving these
                          overrides removes those unknown values.
                        </p>
                      ) : null}

                      <input
                        type="hidden"
                        name="permissionsGrant_present"
                        value="1"
                      />
                      <input
                        type="hidden"
                        name="permissionsDeny_present"
                        value="1"
                      />

                      <div className="mt-3 space-y-4">
                        {ACCESS_PERMISSION_GROUPS.map((group) => (
                          <fieldset
                            key={`overrides-${member.id}-${group.id}`}
                            className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3"
                          >
                            <legend className="px-1 text-xs font-semibold text-[color:var(--team-text)]">
                              {group.label}
                            </legend>
                            <div className="mt-2 hidden grid-cols-[minmax(0,1fr)_88px_88px] gap-2 px-3 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)] sm:grid">
                              <span>Permission</span>
                              <span className="text-center">Grant</span>
                              <span className="text-center">Deny</span>
                            </div>
                            <div className="mt-1 grid gap-2">
                              {group.permissions.map((permission) => (
                                <PermissionOverrideRow
                                  key={`override-${member.id}-${permission}`}
                                  permission={permission}
                                  granted={member.permissionsGrant.includes(
                                    permission,
                                  )}
                                  denied={member.permissionsDeny.includes(
                                    permission,
                                  )}
                                />
                              ))}
                            </div>
                          </fieldset>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </form>
                <details className="mt-3 rounded-2xl border border-red-200 bg-red-50/60 px-4 py-3">
                  <summary className="cursor-pointer text-[11px] font-semibold text-red-700">
                    Danger zone
                  </summary>
                  <div className="mt-3 space-y-2 text-[11px] text-red-700">
                    <p>Delete this team member. This cannot be undone.</p>
                    <form
                      action={`/api/team/access/members/${member.id}/delete`}
                      method="post"
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input
                        name="confirm"
                        placeholder='Type "DELETE" to confirm'
                        className="w-full flex-1 rounded-full border border-red-200 bg-white px-3 py-2 text-xs text-slate-700 sm:min-w-[220px]"
                      />
                      <SubmitButton
                        className="rounded-full bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-red-200/50 transition hover:bg-red-700"
                        pendingLabel="Deleting..."
                      >
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
                </details>
              </div>
            ))}
          </div>
          <form
            action="/api/team/access/members"
            method="post"
            className="mt-5 space-y-3 text-xs text-slate-600"
          >
            <input
              type="hidden"
              name="idempotencyKey"
              value={`access-member-create:${randomUUID()}`}
            />
            <fieldset disabled={Boolean(membersError)} className="contents">
              <label className="flex flex-col gap-1">
                <span>Name</span>
                <input
                  name="name"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Email</span>
                <input
                  name="email"
                  type="email"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Phone</span>
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="6785551234"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Role</span>
                <select
                  name="roleId"
                  defaultValue=""
                  disabled={Boolean(rolesError)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                >
                  <option value="">No role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked
                  className="h-4 w-4 rounded border-slate-300"
                />
                Active
              </label>
              <SubmitButton
                className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Add member
              </SubmitButton>
            </fieldset>
          </form>
        </div>

        <div
          id="sessions"
          className="scroll-mt-24 rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur lg:col-span-2"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Sessions
              </h3>
              <p className="text-xs text-slate-500">
                Review active, expired, revoked, and emergency-access sessions.
                Session secrets and IP addresses are never shown.
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              {!sessionsError ? (
                <span className="text-xs text-slate-500">
                  Showing {sessions.length} of {sessionsTotal}
                </span>
              ) : null}
              <AccessSessionRefreshButton />
            </div>
          </div>

          {sessionsError ? (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="alert"
            >
              {sessionsError} This is not an empty session history.
            </div>
          ) : sessions.length === 0 ? (
            <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No session records exist.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {sessions.map((session) => {
                const isCurrent = session.id === principal.sessionId;
                return (
                  <article
                    key={session.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">
                          {session.memberName}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {session.memberEmail ?? "No email"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {isCurrent ? (
                          <span className="rounded-full border border-primary-200 bg-primary-50 px-2.5 py-1 text-[11px] font-semibold text-primary-800">
                            Current session
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${sessionStatusClasses(session.status)}`}
                        >
                          {session.status}
                        </span>
                        {session.authMethod === "break_glass" ? (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                            Emergency access
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                      <div>
                        <dt className="font-semibold text-slate-700">
                          Started
                        </dt>
                        <dd>{formatSessionTime(session.createdAt)}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-slate-700">
                          Last seen
                        </dt>
                        <dd>{formatSessionTime(session.lastSeenAt)}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-slate-700">
                          Expires
                        </dt>
                        <dd>{formatSessionTime(session.expiresAt)}</dd>
                      </div>
                    </dl>
                    {session.status === "active" && !isCurrent ? (
                      <form
                        action="/api/team/access/sessions/revoke"
                        method="post"
                        className="mt-3"
                      >
                        <input type="hidden" name="scope" value="session" />
                        <input
                          type="hidden"
                          name="sessionId"
                          value={session.id}
                        />
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={`session-revoke:${session.id}`}
                        />
                        <input type="hidden" name="confirm" value="REVOKE" />
                        <SubmitButton
                          className="min-h-[44px] rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                          pendingLabel="Revoking..."
                        >
                          Revoke this session
                        </SubmitButton>
                      </form>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}

          {sessionsTruncated ? (
            <p
              className="mt-3 text-xs font-semibold text-amber-800"
              role="status"
            >
              Only the 200 most recently active sessions are shown. Use a member
              filter or diagnostics before making a security decision.
            </p>
          ) : null}

          {!sessionsError && members.length > 0 ? (
            <details className="mt-5 rounded-2xl border border-rose-200 bg-rose-50/60 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-rose-800">
                Session revocation
              </summary>
              <p className="mt-2 text-xs text-rose-800">
                Revocation is immediate and audited. Type REVOKE for the exact
                member; your current session is preserved when revoking your own
                other sessions.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {members.map((member) => {
                  const memberSessions = sessions.filter(
                    (session) =>
                      session.memberId === member.id &&
                      session.status === "active",
                  );
                  const isCurrentMember = member.id === principal.memberId;
                  const revocableCount = memberSessions.filter(
                    (session) => session.id !== principal.sessionId,
                  ).length;
                  if (revocableCount === 0) return null;
                  return (
                    <form
                      key={`revoke-member-${member.id}`}
                      action="/api/team/access/sessions/revoke"
                      method="post"
                      className="rounded-xl border border-rose-200 bg-white p-3"
                    >
                      <input type="hidden" name="scope" value="member" />
                      <input type="hidden" name="memberId" value={member.id} />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`member-session-revoke:${member.id}:${memberSessions[0]?.id ?? "none"}`}
                      />
                      {isCurrentMember ? (
                        <input type="hidden" name="preserveCurrent" value="1" />
                      ) : null}
                      <div className="text-sm font-semibold text-slate-900">
                        {member.name}
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        {revocableCount} revocable active session
                        {revocableCount === 1 ? "" : "s"}
                      </div>
                      <label className="mt-3 block text-xs text-slate-700">
                        <span className="font-semibold">Type REVOKE</span>
                        <input
                          name="confirm"
                          required
                          autoComplete="off"
                          className="mt-1 min-h-[44px] w-full rounded-xl border border-rose-200 bg-white px-3 py-2"
                        />
                      </label>
                      <SubmitButton
                        className="mt-3 min-h-[44px] rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                        pendingLabel="Revoking..."
                      >
                        {isCurrentMember
                          ? "Revoke my other sessions"
                          : "Revoke all sessions"}
                      </SubmitButton>
                    </form>
                  );
                })}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
