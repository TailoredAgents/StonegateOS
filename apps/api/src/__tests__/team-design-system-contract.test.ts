import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");

function siteSource(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

describe("Team CRM design-system contract", () => {
  const teamUi = siteSource("src/app/team/components/team-ui.ts");
  const globalCss = siteSource("src/app/globals.css");

  it("gives shared buttons and fields a 44px minimum target", () => {
    expect(teamUi).toContain(
      "const baseClass = `inline-flex min-h-11 min-w-11",
    );
    expect(teamUi).toContain("export const TEAM_INPUT = `min-h-11");
    expect(teamUi).toContain("export const TEAM_INPUT_COMPACT = `min-h-11");
  });

  it("uses one visible semantic focus treatment in both themes", () => {
    expect(teamUi).toContain(
      "focus-visible:ring-[color:var(--team-focus-ring)]",
    );
    expect(teamUi).toContain(
      "focus-visible:ring-offset-[color:var(--team-focus-offset)]",
    );
    expect(globalCss.match(/--team-focus-ring:/gu)).toHaveLength(2);
    expect(globalCss.match(/--team-focus-offset:/gu)).toHaveLength(2);
  });

  it("defines static light/dark semantic status and action tokens", () => {
    for (const token of [
      "action-primary",
      "action-primary-hover",
      "action-primary-text",
      "info-surface",
      "info-border",
      "info-text",
      "success-surface",
      "success-border",
      "success-text",
      "warning-surface",
      "warning-border",
      "warning-text",
      "danger-surface",
      "danger-border",
      "danger-text",
    ]) {
      expect(
        globalCss.match(new RegExp(`--team-${token}:`, "gu")),
      ).toHaveLength(2);
    }

    for (const tone of ["info", "success", "warning", "danger"]) {
      expect(teamUi).toContain(`border-[color:var(--team-${tone}-border)]`);
      expect(teamUi).toContain(`bg-[color:var(--team-${tone}-surface)]`);
      expect(teamUi).toContain(`text-[color:var(--team-${tone}-text)]`);
    }
    expect(teamUi).not.toContain("var(--team-${tone}");
  });

  it("keeps reduced-motion behavior and disables decorative skeleton motion", () => {
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalCss).toContain(".team-reduce-motion *");
    expect(teamUi).toContain("motion-reduce:animate-none");
  });
});
