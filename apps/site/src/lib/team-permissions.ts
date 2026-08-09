export function teamPermissionMatches(
  granted: string,
  required: string,
): boolean {
  if (granted === "*") return true;
  if (granted.endsWith(".*")) {
    return required.startsWith(granted.slice(0, -2));
  }
  return granted === required;
}

export function hasTeamPermissionValue(
  permissions: readonly string[],
  required: string,
): boolean {
  return permissions.some((permission) =>
    teamPermissionMatches(permission, required),
  );
}
