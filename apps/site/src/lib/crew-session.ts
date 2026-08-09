export const CREW_SESSION_COOKIE = "myst-crew-session";

export function getCrewKey(): string | null {
  const key = process.env["CREW_SESSION_SECRET"]?.trim() ?? "";
  return key.length > 0 ? key : null;
}

export function crewSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12 hours
  };
}
