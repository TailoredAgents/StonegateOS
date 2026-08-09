import { readFileSync } from "node:fs";
import { join } from "node:path";

const authSource = readFileSync(
  join(process.cwd(), "src/lib/team-auth.ts"),
  "utf8",
);
const routeSource = readFileSync(
  join(process.cwd(), "app/api/team/password/route.ts"),
  "utf8",
);

describe("Team password session safety", () => {
  it("keeps only the approving session and revokes other live sessions atomically", () => {
    const functionStart = authSource.indexOf(
      "export async function setTeamMemberPassword",
    );
    const functionSource = authSource.slice(
      functionStart,
      authSource.indexOf(
        "export async function loginWithPassword",
        functionStart,
      ),
    );

    expect(functionSource).toContain("db.transaction");
    expect(functionSource).toContain(".update(teamMembers)");
    expect(functionSource).toContain(".update(teamSessions)");
    expect(functionSource).toContain("ne(teamSessions.id, currentSessionId)");
    expect(functionSource).toContain("isNull(teamSessions.revokedAt)");
    expect(functionSource).toContain(".delete(teamLoginTokens)");
  });

  it("passes the verified current session ID from the password route", () => {
    expect(routeSource).toContain("session.sessionId");
    expect(routeSource.indexOf("requireTeamSession(request)")).toBeLessThan(
      routeSource.indexOf("request.json()"),
    );
  });
});
