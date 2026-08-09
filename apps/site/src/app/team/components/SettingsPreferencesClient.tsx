"use client";

import React from "react";
import {
  parseTeamMotionPreference,
  parseTeamThemePreference,
  TEAM_MOTION_STORAGE_KEY,
  TEAM_PREFERENCES_EVENT,
  TEAM_THEME_STORAGE_KEY,
  type TeamMotionPreference,
  type TeamPreferencesEventDetail,
  type TeamThemePreference,
} from "../team-preferences";

function announcePreferences(detail: TeamPreferencesEventDetail): void {
  globalThis.dispatchEvent(
    new CustomEvent<TeamPreferencesEventDetail>(TEAM_PREFERENCES_EVENT, {
      detail,
    }),
  );
}

export function SettingsPreferencesClient(): React.ReactElement {
  const [theme, setTheme] = React.useState<TeamThemePreference>("light");
  const [motion, setMotion] =
    React.useState<TeamMotionPreference>("system");
  const [status, setStatus] = React.useState("");

  React.useEffect(() => {
    setTheme(
      parseTeamThemePreference(
        globalThis.localStorage?.getItem(TEAM_THEME_STORAGE_KEY),
      ) ?? "light",
    );
    setMotion(
      parseTeamMotionPreference(
        globalThis.localStorage?.getItem(TEAM_MOTION_STORAGE_KEY),
      ),
    );

    function handlePreferenceChange(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as TeamPreferencesEventDetail | undefined;
      const nextTheme = parseTeamThemePreference(detail?.theme);
      if (nextTheme) setTheme(nextTheme);
      if (detail?.motion) {
        setMotion(parseTeamMotionPreference(detail.motion));
      }
    }

    globalThis.addEventListener(TEAM_PREFERENCES_EVENT, handlePreferenceChange);
    return () => {
      globalThis.removeEventListener(
        TEAM_PREFERENCES_EVENT,
        handlePreferenceChange,
      );
    };
  }, []);

  function chooseTheme(next: TeamThemePreference): void {
    try {
      globalThis.localStorage?.setItem(TEAM_THEME_STORAGE_KEY, next);
      setTheme(next);
      announcePreferences({ theme: next });
      setStatus(`${next === "dark" ? "Dark" : "Light"} theme saved.`);
    } catch {
      setStatus("Theme changed for this visit but could not be saved.");
      setTheme(next);
      announcePreferences({ theme: next });
    }
  }

  function chooseMotion(next: TeamMotionPreference): void {
    try {
      globalThis.localStorage?.setItem(TEAM_MOTION_STORAGE_KEY, next);
      setMotion(next);
      announcePreferences({ motion: next });
      setStatus(
        next === "reduce"
          ? "Reduced motion saved."
          : "System motion preference restored.",
      );
    } catch {
      setStatus("Motion preference changed for this visit but could not be saved.");
      setMotion(next);
      announcePreferences({ motion: next });
    }
  }

  const buttonClass =
    "min-h-[44px] rounded-xl border px-4 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary-200";

  return (
    <section
      className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
      aria-labelledby="team-display-preferences-title"
    >
      <h3
        id="team-display-preferences-title"
        className="text-sm font-semibold text-[color:var(--team-text)]"
      >
        Display and accessibility
      </h3>
      <p className="mt-1 text-xs leading-5 text-[color:var(--team-text-muted)]">
        These preferences stay in this browser and apply immediately throughout
        the Team CRM.
      </p>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-[color:var(--team-text)]">
          Theme
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["light", "dark"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => chooseTheme(option)}
              className={`${buttonClass} ${
                theme === option
                  ? "border-primary-300 bg-primary-50 text-primary-800"
                  : "border-[color:var(--team-border)] bg-[color:var(--team-card)] text-[color:var(--team-text)]"
              }`}
            >
              {option === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-[color:var(--team-text)]">
          Motion
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["system", "reduce"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={motion === option}
              onClick={() => chooseMotion(option)}
              className={`${buttonClass} ${
                motion === option
                  ? "border-primary-300 bg-primary-50 text-primary-800"
                  : "border-[color:var(--team-border)] bg-[color:var(--team-card)] text-[color:var(--team-text)]"
              }`}
            >
              {option === "reduce" ? "Reduce motion" : "Use system setting"}
            </button>
          ))}
        </div>
      </fieldset>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </p>
    </section>
  );
}
