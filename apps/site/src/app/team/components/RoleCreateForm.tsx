"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  ACCESS_PERMISSION_GROUPS,
  ACCESS_ROLE_TEMPLATE_OPTIONS,
  describeAccessPermission,
  getAccessRoleTemplate,
  normalizeAccessRolePermissionSelection,
} from "../access-role-templates";
import {
  TEAM_FOCUS_RING,
  TEAM_INPUT,
  TEAM_SELECT,
  teamButtonClass,
} from "./team-ui";

export function RoleCreateForm({
  disabled,
  idempotencyKey,
}: {
  disabled: boolean;
  idempotencyKey: string;
}): React.ReactElement {
  const [templateId, setTemplateId] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState(
    "No permission template has been applied.",
  );
  const selectedPermissionSet = useMemo(
    () => new Set(selectedPermissions),
    [selectedPermissions],
  );
  const selectedTemplate = getAccessRoleTemplate(templateId);

  function applyTemplate(): void {
    if (!selectedTemplate) return;
    const next = normalizeAccessRolePermissionSelection(
      selectedTemplate.permissions,
    );
    setSelectedPermissions(next);
    setAnnouncement(
      `${selectedTemplate.label} applied with ${next.length} permissions. Review every permission before saving.`,
    );
  }

  function clearPermissions(): void {
    setSelectedPermissions([]);
    setAnnouncement(
      "All permissions cleared. This role will have no CRM access.",
    );
  }

  function setPermission(permission: string, checked: boolean): void {
    const next = new Set(selectedPermissions);
    if (checked) next.add(permission);
    else next.delete(permission);
    const normalized = normalizeAccessRolePermissionSelection(next);
    setSelectedPermissions(normalized);
    setAnnouncement(
      `${normalized.length} permission${normalized.length === 1 ? "" : "s"} selected.`,
    );
  }

  return (
    <form
      action="/api/team/access/roles"
      method="post"
      className="mt-5 space-y-4 text-xs text-[color:var(--team-text-muted)]"
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset disabled={disabled} className="contents">
        <div className="rounded-2xl border border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] p-4 text-[color:var(--team-info-text)]">
          <label className="flex flex-col gap-1 font-semibold">
            Permission starting point
            <select
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value);
                setAnnouncement(
                  event.target.value
                    ? "Template selected but not applied."
                    : "No permission template selected.",
                );
              }}
              aria-describedby="role-template-help role-template-status"
              className={`${TEAM_SELECT} font-normal`}
            >
              <option value="">Custom — start with no permissions</option>
              {ACCESS_ROLE_TEMPLATE_OPTIONS.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </label>
          <p id="role-template-help" className="mt-2 text-[11px]">
            A template only fills the checklist. It never grants access until
            you review the list and create the role. Built-in Owner access is
            intentionally unavailable as a template.
          </p>
          {selectedTemplate ? (
            <p className="mt-2 text-[11px]">{selectedTemplate.description}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={applyTemplate}
              disabled={!selectedTemplate}
              className={teamButtonClass("primary", "sm")}
            >
              Apply selected template
            </button>
            <button
              type="button"
              onClick={clearPermissions}
              className={teamButtonClass("secondary", "sm")}
            >
              Clear permissions
            </button>
          </div>
          <p
            id="role-template-status"
            role="status"
            aria-live="polite"
            className="mt-2 text-[11px] font-medium"
          >
            {announcement}
          </p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-[color:var(--team-text)]">
            Role name
          </span>
          <input
            name="name"
            required
            maxLength={120}
            autoComplete="off"
            className={TEAM_INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold text-[color:var(--team-text)]">
            Unique role slug
          </span>
          <input
            name="slug"
            required
            maxLength={64}
            minLength={2}
            pattern={"[A-Za-z][A-Za-z0-9_\\-]{1,63}"}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="field_sales_east"
            aria-describedby="role-slug-help"
            className={`${TEAM_INPUT} font-mono`}
          />
          <span
            id="role-slug-help"
            className="text-[11px] text-[color:var(--team-text-soft)]"
          >
            Use a stable lowercase identifier. Owner, office, sales, crew, and
            read_only are protected built-in slugs.
          </span>
        </label>
        <fieldset className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
          <legend className="px-1 text-xs font-semibold text-[color:var(--team-text)]">
            Exact permissions ({selectedPermissions.length})
          </legend>
          <p className="mb-3 text-[11px] text-[color:var(--team-text-soft)]">
            Select only the work this role needs. Individual denies still take
            priority over role permissions.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {ACCESS_PERMISSION_GROUPS.map((group) => (
              <div key={`new-role-${group.id}`}>
                <h4 className="text-[11px] font-semibold text-[color:var(--team-text)]">
                  {group.label}
                </h4>
                <div className="mt-1.5 grid gap-1">
                  {group.permissions.map((permission) => (
                    <PermissionChoice
                      key={`new-role-${permission}`}
                      permission={permission}
                      checked={selectedPermissionSet.has(permission)}
                      onChange={(checked) => setPermission(permission, checked)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        <SubmitButton
          className={teamButtonClass("primary", "sm")}
          pendingLabel="Creating role..."
        >
          Create reviewed role
        </SubmitButton>
      </fieldset>
    </form>
  );
}

function PermissionChoice({
  permission,
  checked,
  onChange,
}: {
  permission: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  const presentation = describeAccessPermission(permission);
  return (
    <label className="flex min-h-[52px] items-center gap-3 rounded-lg px-2 py-1.5 text-xs text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface)]">
      <input
        type="checkbox"
        name="permissions"
        value={permission}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={`h-5 w-5 shrink-0 rounded border-[color:var(--team-border-strong)] ${TEAM_FOCUS_RING}`}
      />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 font-semibold text-[color:var(--team-text)]">
          {presentation.label}
          {presentation.sensitive ? (
            <span className="rounded-full border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--team-warning-text)]">
              Sensitive
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block break-all font-mono text-[10px] text-[color:var(--team-text-soft)]">
          {permission}
        </span>
      </span>
    </label>
  );
}
