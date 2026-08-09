import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTeamMotionPreference,
  parseTeamThemePreference,
} from "../../../site/src/app/team/team-preferences";

const TEAM_COMPONENTS = join(process.cwd(), "../site/src/app/team/components");
const TEAM_ROOT = join(process.cwd(), "../site/src/app/team");

function component(name: string): string {
  return readFileSync(join(TEAM_COMPONENTS, name), "utf8");
}

describe("modern Team shell accessibility contract", () => {
  it("provides one page heading, a skip target, and named navigation", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell.match(/<h1\b/gu)).toHaveLength(1);
    expect(shell).toContain("Skip to main content");
    expect(shell).toContain("TEAM_MAIN_ID");
    expect(shell).toContain("tabIndex={-1}");
    expect(shell).toContain('aria-labelledby="team-page-title"');
    expect(shell).toContain('"Primary team navigation"');
    expect(shell).toContain('"Mobile team navigation"');
    expect(shell).toContain('aria-label="Quick team navigation"');
  });

  it("keeps the mobile drawer named, modal, trapped, and reversible", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell).toContain('aria-haspopup="dialog"');
    expect(shell).toContain("aria-expanded={mobileOpen}");
    expect(shell).toContain("aria-controls={MOBILE_DRAWER_ID}");
    expect(shell).toContain('role="dialog"');
    expect(shell).toContain('aria-modal="true"');
    expect(shell).toContain('aria-labelledby="team-mobile-navigation-title"');
    expect(shell).toContain('event.key === "Escape"');
    expect(shell).toContain('event.key !== "Tab"');
    expect(shell).toContain('document.body.style.overflow = "hidden"');
    expect(shell).toContain("inert={mobileOpen ? true : undefined}");
    expect(shell).toContain("getDrawerFocusableElements(drawer)");
    expect(shell).toContain(
      `!element.closest('[hidden], [inert], [aria-hidden="true"]')`,
    );
    expect(shell).toContain("element.getClientRects().length > 0");
    expect(shell).toContain("!drawer.contains(activeElement)");
    expect(shell).toContain('mobileFocusDestinationRef.current === "main"');
    expect(shell).toContain("fallbackFocusTarget");
    expect(shell).toContain("mobileCloseButtonRef.current?.focus()");
  });

  it("unlocks and returns focus when a phone drawer crosses the desktop breakpoint", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell).toContain(
      'const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)"',
    );
    expect(shell).toContain("globalThis.matchMedia?.(DESKTOP_MEDIA_QUERY)");
    expect(shell).toContain(
      "if (desktopMedia.matches) closeMobileNavigation()",
    );
    expect(shell).toContain(
      'desktopMedia.addEventListener("change", closeDrawerAtDesktop)',
    );
    expect(shell).toContain(
      'desktopMedia.removeEventListener("change", closeDrawerAtDesktop)',
    );
    expect(shell).toContain(
      "document.body.style.overflow = previousBodyOverflow",
    );
  });

  it("does not collapse or dismiss the drawer for non-navigation controls", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell).not.toContain('target.closest("button")');
    expect(shell).toContain(
      "renderSidebarContent({ isCollapsed: false, isMobile: true })",
    );
    expect(shell).toContain("onClick={handleToggleTheme}");
    expect(shell).toContain("onClick={() => toggleGroupCollapsed(group.id)}");
    expect(shell).toContain("onClick={closeMobileNavigation}");
    expect(shell).toContain("setMobileOpen(false)");
  });

  it("announces navigation and enforces mobile-size controls", () => {
    const shell = component("TeamAppShell.tsx");
    const tabNav = component("TabNav.tsx");

    expect(shell).toContain('role="status"');
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain("min-h-[44px]");
    expect(shell).toContain("h-11 w-11");
    expect(tabNav).toContain("min-h-[44px]");
    expect(tabNav).toContain('aria-live="polite"');
  });

  it("keeps the five daily anchors ordered and makes reduced role sets fill the phone bar", () => {
    const shell = component("TeamAppShell.tsx");
    const page = readFileSync(join(TEAM_ROOT, "page.tsx"), "utf8");

    expect(page).toContain(
      'const quickIds = ["calendar", "inbox", "contacts", "quotes", "expenses"]',
    );
    expect(shell).toContain("const MAX_MOBILE_DAILY_ANCHORS = 5");
    expect(shell).toContain(
      "props.quickItems.slice(0, MAX_MOBILE_DAILY_ANCHORS)",
    );
    expect(shell).toContain(
      "gridTemplateColumns: `repeat(${mobileNavItems.length}, minmax(0, 1fr))`",
    );
    expect(shell).toContain("mobileNavItems.length > 0");
  });

  it("keeps phone utilities reachable without crowding the 320px header", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell).toContain("Account and tools");
    expect(shell).toContain("isMobile && utilityItems.length > 0");
    expect(shell).toContain("flex min-w-0 flex-1 items-center gap-3");
    expect(shell).toContain("flex shrink-0 items-center gap-2 sm:gap-3");
    expect(shell).toContain("sm:inline-flex");
    expect(shell).toContain("h-[calc(100dvh-68px)]");
  });

  it("persists collapse controls safely and exposes access state without color", () => {
    const shell = component("TeamAppShell.tsx");

    expect(shell).toContain("function readTeamStorage(key: string)");
    expect(shell).toContain("function writeTeamStorage(key: string");
    expect(shell).toContain("readTeamStorage(SIDEBAR_STORAGE_KEY)");
    expect(shell).toContain("writeTeamStorage(SIDEBAR_STORAGE_KEY");
    expect(shell).toContain("writeTeamStorage(GROUPS_STORAGE_KEY");
    expect(shell).toContain('{enabled ? "Access" : "Restricted"}');
  });

  it("supports keyboard-safe classic group menus", () => {
    const tabNav = component("TabNav.tsx");

    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(tabNav).toContain(`event.key === "${key}"`);
    }
    expect(tabNav).toContain("groupTriggerRefs.current[groupId]?.focus()");
    expect(tabNav).toContain('focusMenuItem(group.id, "first")');
    expect(tabNav).toContain('focusMenuItem(group.id, "last")');
    expect(tabNav).toContain('role="menu"');
    expect(tabNav).toContain('role="menuitem"');
    expect(tabNav).toContain("hidden={!isOpenGroup}");
  });
});

describe("Team settings accessibility and privacy contract", () => {
  const settings = readFileSync(
    join(TEAM_ROOT, "settings-surface.tsx"),
    "utf8",
  );
  const preferences = component("SettingsPreferencesClient.tsx");
  const shell = component("TeamAppShell.tsx");
  const globalStyles = readFileSync(
    join(process.cwd(), "../site/src/app/globals.css"),
    "utf8",
  );

  it("offers persistent theme and reduced-motion controls that update the shell", () => {
    expect(parseTeamThemePreference("light")).toBe("light");
    expect(parseTeamThemePreference("dark")).toBe("dark");
    expect(parseTeamThemePreference("unexpected")).toBeNull();
    expect(parseTeamMotionPreference("reduce")).toBe("reduce");
    expect(parseTeamMotionPreference("unexpected")).toBe("system");
    expect(preferences).toContain("aria-pressed={theme === option}");
    expect(preferences).toContain("aria-pressed={motion === option}");
    expect(preferences).toContain("TEAM_PREFERENCES_EVENT");
    expect(preferences).toContain('role="status"');
    expect(shell).toContain("TEAM_MOTION_STORAGE_KEY");
    expect(shell).toContain("team-reduce-motion");
    expect(globalStyles).toContain(".team-reduce-motion *");
    expect(globalStyles).toContain("animation-duration: 0.01ms !important");
  });

  it("keeps owner exports and integration health under an explicit advanced area", () => {
    expect(settings).toContain("Advanced diagnostics and data tools");
    expect(settings).toContain("Message bodies are sensitive personal data");
    expect(settings).toContain("integration is healthy or empty");
    expect(settings).toContain('role="alert"');
    expect(settings).toContain('aria-live="polite"');
    expect(settings).toContain("min-h-[44px]");
  });
});
