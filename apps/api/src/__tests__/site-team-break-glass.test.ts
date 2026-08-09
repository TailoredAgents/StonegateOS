import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE_ROOT = join(process.cwd(), "../site/src");
const API_ROOT = process.cwd();

function site(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

function api(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

describe("legacy-to-team break-glass boundary", () => {
  it("never treats legacy cookies as a Team principal", () => {
    const principal = site("lib/team-principal.ts");
    expect(principal).toContain("TEAM_SESSION_COOKIE");
    expect(principal).not.toContain("ADMIN_SESSION_COOKIE");
    expect(principal).not.toContain("CREW_SESSION_COOKIE");
    expect(principal).not.toContain("myst-admin-session");
    expect(principal).not.toContain("myst-crew-session");
  });

  it("validates both legacy secrets at the Site without forwarding either value", () => {
    const action = site("app/team/login/actions.ts");
    const comparison = site("lib/legacy-session-secret.ts");
    const apiHelper = site("app/team/login/lib/api.ts");

    expect(comparison).toContain("crypto.timingSafeEqual");
    expect(action).toContain("getAdminSessionSecret()");
    expect(action).toContain(
      "legacySessionSecretMatches(crewCookie, getCrewKey())",
    );
    expect(action).toContain("legacyType: LegacyRecoveryType =");
    expect(apiHelper).toContain('"x-actor-label": "team-break-glass-exchange"');
    expect(apiHelper).toContain(
      "JSON.stringify({ legacyType: input.legacyType })",
    );
    expect(apiHelper).not.toContain("ownerCookie");
    expect(apiHelper).not.toContain("crewCookie");
  });

  it("keeps the browser recovery secret independent from the API service key", () => {
    const adminSession = site("lib/admin-session.ts");
    const action = site("app/team/login/actions.ts");
    const middleware = site("middleware.ts");

    expect(adminSession).toContain('process.env["ADMIN_SESSION_SECRET"]');
    expect(adminSession).not.toContain("ADMIN_API_KEY");
    expect(action).toContain("getAdminSessionSecret");
    expect(middleware).toContain("adminSessionMatches(");
    expect(middleware).not.toContain("if (!adminKey)");
    expect(middleware).not.toContain("getAdminKey");
  });

  it("sets only the returned opaque Team cookie and clears both legacy cookies", () => {
    const action = site("app/team/login/actions.ts");
    const setIndex = action.indexOf("jar.set(");
    const ownerDelete = action.indexOf("jar.delete(ADMIN_SESSION_COOKIE)");
    const crewDelete = action.indexOf("jar.delete(CREW_SESSION_COOKIE)");

    expect(setIndex).toBeGreaterThan(-1);
    expect(ownerDelete).toBeGreaterThan(setIndex);
    expect(crewDelete).toBeGreaterThan(setIndex);
    expect(action).toContain("breakGlassTeamSessionCookieOptions()");
  });

  it("shows the POST-only accessible recovery form only after cookie presence is detected", () => {
    const page = site("app/team/login/page.tsx");
    const button = site("app/team/login/RecoverySubmitButton.tsx");

    expect(page).toContain("hasLegacyRecoveryCookie ? (");
    expect(page).toContain("action={exchangeLegacyTeamSessionAction}");
    expect(button).toContain("disabled={pending}");
    expect(button).toContain("aria-disabled={pending}");
  });

  it("has no built-in crew secret and persists the verified session method through migration 0064", () => {
    const crewSession = site("lib/crew-session.ts");
    const migration = api(
      "src/db/migrations/0064_team_session_auth_method.sql",
    );

    expect(crewSession).toContain('process.env["CREW_SESSION_SECRET"]');
    expect(crewSession).not.toContain("Mystteam");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "auth_method"');
    expect(migration).toContain("'break_glass'");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });
});
