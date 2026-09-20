const TEAM_RETURN_ORIGIN = "https://team-return.invalid";

/** A navigation hint only. The destination must still authorize its reader. */
export function safeTeamReturnPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return null;
  try {
    const target = new URL(value, TEAM_RETURN_ORIGIN);
    const decodedPath = decodeURIComponent(target.pathname);
    if (
      target.origin !== TEAM_RETURN_ORIGIN ||
      (target.pathname !== "/team" && !target.pathname.startsWith("/team/")) ||
      /[\\\u0000-\u0020\u007f]/u.test(decodedPath) ||
      /%2f|%5c/iu.test(target.pathname) ||
      /^\/team\/(?:login|auth|logout)(?:\/|$)/u.test(decodedPath) ||
      target.hash
    )
      return null;
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}

export function teamLoginHref(
  returnTo: unknown,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams(query);
  const destination = safeTeamReturnPath(returnTo);
  if (destination && destination !== "/team")
    params.set("returnTo", destination);
  return `/team/login${params.size ? `?${params.toString()}` : ""}`;
}

export function teamPasswordSetupHref(
  returnTo: unknown,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ setup: "1", ...query });
  const destination = safeTeamReturnPath(returnTo);
  if (destination && destination !== "/team")
    params.set("returnTo", destination);
  return `/team/settings?${params.toString()}`;
}
