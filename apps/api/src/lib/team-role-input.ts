export const BUILT_IN_TEAM_ROLE_SLUGS = [
  "owner",
  "office",
  "sales",
  "crew",
  "read_only",
] as const;

const BUILT_IN_TEAM_ROLE_SLUG_SET: ReadonlySet<string> = new Set(
  BUILT_IN_TEAM_ROLE_SLUGS,
);

const TEAM_ROLE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;

export function normalizeTeamRoleSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidTeamRoleSlug(value: string): boolean {
  return TEAM_ROLE_SLUG_PATTERN.test(normalizeTeamRoleSlug(value));
}

export function isBuiltInTeamRoleSlug(value: string): boolean {
  return BUILT_IN_TEAM_ROLE_SLUG_SET.has(normalizeTeamRoleSlug(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTeamRoleSlugUniqueViolation(error: unknown): boolean {
  const direct = isRecord(error) ? error : null;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const candidate = cause ?? direct;
  if (!candidate || candidate["code"] !== "23505") return false;

  const constraint =
    typeof candidate["constraint_name"] === "string"
      ? candidate["constraint_name"]
      : typeof candidate["constraint"] === "string"
        ? candidate["constraint"]
        : null;
  const message =
    typeof candidate["message"] === "string" ? candidate["message"] : "";
  return (
    constraint === "team_roles_slug_key" ||
    message.includes("team_roles_slug_key")
  );
}
