import { isAssignableTeamPermission, type TeamPermission } from "@myst-os/sdk";

export type AssignableTeamPermission = Exclude<
  TeamPermission,
  "access.break_glass" | "contacts.purge" | "sessions.manage_self"
>;

export type PermissionListValidation =
  | { ok: true; permissions: AssignableTeamPermission[] }
  | {
      ok: false;
      code: "permissions_must_be_an_array" | "unsupported_permissions";
      invalidEntries: string[];
    };

/**
 * Parse role/member permissions at the API trust boundary.
 *
 * Wildcards, the legacy generic `read` value, unknown strings, and the
 * reserved break-glass exchange, Owner-only purge, and self-session
 * permissions are intentionally not assignable. Self-session management
 * belongs to every verified person, independent of their CRM job role.
 */
export function validateAssignableTeamPermissions(
  value: unknown,
): PermissionListValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: "permissions_must_be_an_array",
      invalidEntries: [],
    };
  }

  const permissions: AssignableTeamPermission[] = [];
  const invalidEntries: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const normalized = typeof entry === "string" ? entry.trim() : "";
    if (!isAssignableTeamPermission(normalized)) {
      const label = normalized || `<${typeof entry}>`;
      if (!invalidEntries.includes(label)) invalidEntries.push(label);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    permissions.push(normalized);
  }

  if (invalidEntries.length > 0) {
    return {
      ok: false,
      code: "unsupported_permissions",
      invalidEntries,
    };
  }

  return { ok: true, permissions };
}
