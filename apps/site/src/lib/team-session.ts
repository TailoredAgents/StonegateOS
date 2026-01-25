export const TEAM_SESSION_COOKIE = "myst-team-session";

export function teamSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    // Keep this longer than the old admin/crew cookies; the token can be revoked server-side.
    maxAge: 60 * 60 * 24 * 14 // 14 days
  };
}

