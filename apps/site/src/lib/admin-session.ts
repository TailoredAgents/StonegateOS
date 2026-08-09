export const ADMIN_SESSION_COOKIE = "myst-admin-session";
const MAX_ADMIN_SESSION_SECRET_LENGTH = 512;

export function getAdminSessionSecret(): string | null {
  const secret = process.env["ADMIN_SESSION_SECRET"]?.trim() ?? "";
  const minimumLength = process.env["NODE_ENV"] === "production" ? 32 : 1;
  return secret.length >= minimumLength &&
    secret.length <= MAX_ADMIN_SESSION_SECRET_LENGTH
    ? secret
    : null;
}

export function adminSessionMatches(
  provided: string | null | undefined,
): boolean {
  const expected = getAdminSessionSecret();
  const candidate = typeof provided === "string" ? provided : "";
  if (
    !expected ||
    !candidate ||
    candidate.length > MAX_ADMIN_SESSION_SECRET_LENGTH
  ) {
    return false;
  }

  // Keep the comparison synchronous and Edge-runtime compatible for
  // middleware while avoiding an early-return character comparison.
  let difference = candidate.length ^ expected.length;
  for (let index = 0; index < MAX_ADMIN_SESSION_SECRET_LENGTH; index += 1) {
    difference |=
      (candidate.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function adminSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours
  };
}
