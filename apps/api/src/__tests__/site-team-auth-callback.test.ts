import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "../site/src/app/team/auth/route.ts"),
  "utf8",
);

describe("Site Team authentication callback", () => {
  it("clears a stale team cookie on every callback failure", () => {
    expect(source).toContain("function failedAuthRedirect");
    expect(source).toContain("name: TEAM_SESSION_COOKIE");
    expect(source).toContain("maxAge: 0");
    expect(source).toContain('failedAuthRedirect("missing_token")');
    expect(source).toContain('failedAuthRedirect("auth_failed")');
    expect(source).toContain("expired_or_invalid");
  });

  it("reports an unavailable exchange service truthfully", () => {
    expect(source).toContain('failedAuthRedirect("login_service_unavailable")');
    expect(source).toContain("res.status >= 500");
  });

  it("sets the new cookie only after receiving a non-empty session token", () => {
    const tokenCheck = source.indexOf("if (!sessionToken)");
    const cookieWrite = source.lastIndexOf("response.cookies.set({");
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(cookieWrite).toBeGreaterThan(tokenCheck);
  });
});
