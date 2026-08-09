"use client";

import { useMemo, useState } from "react";
import {
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
} from "@myst-os/sdk";
import { SubmitButton } from "@/components/SubmitButton";
import type { AccessRoleRecord } from "../access-role-page";
import {
  ACCESS_PERMISSION_GROUPS,
  describeAccessPermission,
  normalizeAccessRolePermissionSelection,
} from "../access-role-templates";
import { TEAM_INPUT, TEAM_FOCUS_RING, teamButtonClass } from "./team-ui";

const BUILT_IN_SLUGS = new Set([
  "owner",
  "office",
  "sales",
  "crew",
  "read_only",
]);

function editablePermissions(role: AccessRoleRecord): string[] {
  return normalizeAccessRolePermissionSelection(
    role.permissions.includes("*")
      ? TEAM_ASSIGNABLE_PERMISSION_CATALOG
      : role.permissions,
  );
}

export function RoleEditForm({
  role,
}: {
  role: AccessRoleRecord;
}): React.ReactElement {
  const savedPermissions = useMemo(() => editablePermissions(role), [role]);
  const [selectedPermissions, setSelectedPermissions] =
    useState(savedPermissions);
  const [announcement, setAnnouncement] = useState(
    `${savedPermissions.length} saved permissions loaded.`,
  );
  const selected = useMemo(
    () => new Set(selectedPermissions),
    [selectedPermissions],
  );
  const builtIn = BUILT_IN_SLUGS.has(role.slug.toLowerCase());
  const droppedLegacyPermissions = role.permissions.filter(
    (permission) =>
      permission !== "*" &&
      !TEAM_OWNER_ONLY_PERMISSION_CATALOG.includes(
        permission as (typeof TEAM_OWNER_ONLY_PERMISSION_CATALOG)[number],
      ) &&
      !TEAM_ASSIGNABLE_PERMISSION_CATALOG.includes(
        permission as (typeof TEAM_ASSIGNABLE_PERMISSION_CATALOG)[number],
      ),
  );

  function setPermission(permission: string, checked: boolean): void {
    const next = new Set(selectedPermissions);
    if (checked) next.add(permission);
    else next.delete(permission);
    const normalized = normalizeAccessRolePermissionSelection(next);
    setSelectedPermissions(normalized);
    setAnnouncement(
      `${normalized.length} permission${normalized.length === 1 ? "" : "s"} selected. Changes are not saved yet.`,
    );
  }

  function restoreSaved(): void {
    setSelectedPermissions(savedPermissions);
    setAnnouncement(
      "Saved permissions restored. No permission changes are selected.",
    );
  }

  return (
    <form
      action={`/api/team/access/roles/${encodeURIComponent(role.id)}`}
      method="post"
      className="mt-4 space-y-4 border-t border-[color:var(--team-border)] pt-4"
    >
      <input type="hidden" name="expectedUpdatedAt" value={role.updatedAt} />
      <input
        type="hidden"
        name="idempotencyKey"
        value={`access-role-update:${role.id}:${role.updatedAt}`}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text)]">
          Role name
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={role.name}
            className={TEAM_INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text)]">
          Unique role slug
          <input
            name="slug"
            required
            readOnly={builtIn}
            maxLength={64}
            minLength={2}
            pattern={"[A-Za-z][A-Za-z0-9_\\-]{1,63}"}
            defaultValue={role.slug}
            aria-describedby={`role-${role.id}-slug-help`}
            className={`${TEAM_INPUT} font-mono read-only:cursor-not-allowed read-only:opacity-70`}
          />
          <span
            id={`role-${role.id}-slug-help`}
            className="font-normal text-[10px] text-[color:var(--team-text-soft)]"
          >
            {builtIn
              ? "This built-in slug is permanent. Its name and reviewed permission list may still be updated."
              : "Changing a slug or permission signs out assigned members so new access takes effect immediately."}
          </span>
        </label>
      </div>

      {role.permissions.includes("*") ? (
        <p className="rounded-xl border border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] p-3 text-xs text-[color:var(--team-info-text)]">
          The legacy all-permissions wildcard is shown as the exact current
          assignable catalog. Saving replaces the wildcard with this reviewed
          list so individual denies remain predictable.
        </p>
      ) : null}
      {role.slug.toLowerCase() === "owner" ? (
        <p className="rounded-xl border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] p-3 text-xs text-[color:var(--team-warning-text)]">
          Irreversible Owner maintenance permissions are system-managed and
          remain preserved when this reviewed work-permission list is saved.
        </p>
      ) : null}
      {droppedLegacyPermissions.length > 0 ? (
        <p
          className="rounded-xl border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] p-3 text-xs text-[color:var(--team-warning-text)]"
          role="alert"
        >
          {droppedLegacyPermissions.length} unsupported legacy permission
          {droppedLegacyPermissions.length === 1 ? " is" : "s are"} not
          selected. Saving removes those unsupported values.
        </p>
      ) : null}

      <fieldset className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
        <legend className="px-1 text-xs font-semibold text-[color:var(--team-text)]">
          Reviewed permissions ({selectedPermissions.length})
        </legend>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          {ACCESS_PERMISSION_GROUPS.map((group) => (
            <fieldset key={`edit-${role.id}-${group.id}`}>
              <legend className="text-[11px] font-semibold text-[color:var(--team-text-muted)]">
                {group.label}
              </legend>
              <div className="mt-1 grid gap-1">
                {group.permissions.map((permission) => {
                  const presentation = describeAccessPermission(permission);
                  return (
                    <label
                      key={`edit-${role.id}-${permission}`}
                      className="flex min-h-[52px] items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-[color:var(--team-surface)]"
                    >
                      <input
                        type="checkbox"
                        name="permissions"
                        value={permission}
                        checked={selected.has(permission)}
                        onChange={(event) =>
                          setPermission(permission, event.target.checked)
                        }
                        className={`h-5 w-5 shrink-0 rounded border-[color:var(--team-border-strong)] ${TEAM_FOCUS_RING}`}
                      />
                      <span className="min-w-0">
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
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </fieldset>

      <p
        role="status"
        aria-live="polite"
        className="text-xs text-[color:var(--team-text-muted)]"
      >
        {announcement}
      </p>
      <p className="text-xs text-[color:var(--team-warning-text)]">
        Permission or slug changes revoke every active session assigned to this
        role. Review the exact list before saving.
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          className={teamButtonClass("primary", "sm")}
          pendingLabel="Updating role..."
        >
          Save reviewed role
        </SubmitButton>
        <button
          type="button"
          onClick={restoreSaved}
          className={teamButtonClass("secondary", "sm")}
        >
          Restore saved permissions
        </button>
      </div>
    </form>
  );
}
