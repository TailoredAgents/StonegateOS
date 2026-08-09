export type TeamThemePreference = "light" | "dark";
export type TeamMotionPreference = "system" | "reduce";

export const TEAM_THEME_STORAGE_KEY = "team.theme.v1";
export const TEAM_MOTION_STORAGE_KEY = "team.motion.v1";
export const TEAM_PREFERENCES_EVENT = "team-preferences-change";

export type TeamPreferencesEventDetail = {
  theme?: TeamThemePreference;
  motion?: TeamMotionPreference;
};

export function parseTeamThemePreference(
  value: string | null | undefined,
): TeamThemePreference | null {
  return value === "light" || value === "dark" ? value : null;
}

export function parseTeamMotionPreference(
  value: string | null | undefined,
): TeamMotionPreference {
  return value === "reduce" ? "reduce" : "system";
}
