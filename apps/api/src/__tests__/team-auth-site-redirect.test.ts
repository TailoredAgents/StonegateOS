import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTeamAuthRedirect } from "../../../site/src/app/team/auth/redirect";

const REPOSITORY_ROOT = join(process.cwd(), "../..");

describe("Team authentication callback redirects", () => {
  it("uses a relative same-authority location without guessing HTTP or HTTPS", () => {
    const response = createTeamAuthRedirect(
      "/team/login?error=expired_or_invalid",
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/team/login?error=expired_or_invalid",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    "https://attacker.example/team",
    "//attacker.example/team",
    "/partners/login",
  ])("rejects an out-of-scope destination: %s", (destination) => {
    expect(() => createTeamAuthRedirect(destination)).toThrow(
      "Team authentication redirects must stay under /team",
    );
  });

  it("keeps the callback independent of proxy and configured public origins", () => {
    const source = readFileSync(
      join(REPOSITORY_ROOT, "apps/site/src/app/team/auth/route.ts"),
      "utf8",
    );

    expect(source).toContain("createTeamAuthRedirect(");
    expect(source).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(source).not.toContain("x-forwarded-proto");
    expect(source).not.toContain("x-forwarded-host");
    expect(source).not.toContain("NextResponse.redirect");
  });
});
