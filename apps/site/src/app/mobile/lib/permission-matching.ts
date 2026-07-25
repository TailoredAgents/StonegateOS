const GENERIC_READ_EXCLUSIONS = new Set(["payments.read"]);

function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (required === "read") return granted === "read";
  if (granted === "read") {
    return (
      required === "read" ||
      (required.endsWith(".read") &&
        !GENERIC_READ_EXCLUSIONS.has(required))
    );
  }
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -2);
    return required.startsWith(prefix);
  }
  return granted === required;
}

export function hasMobilePermission(
  permissions: string[],
  required: string,
): boolean {
  return permissions.some((permission) =>
    permissionMatches(permission, required),
  );
}
