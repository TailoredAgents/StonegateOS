import fs from "node:fs";
import path from "node:path";
import {
  isSameOriginTeamRequest,
  teamRequestRequiresOrigin,
} from "../../../site/src/lib/team-request-origin";

const SITE_TEAM_ROUTE_ROOT = path.resolve(
  __dirname,
  "../../../site/src/app/api/team",
);
const UNSAFE_ROUTE_EXPORT =
  /export\s+(?:async\s+function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/gu;

function listRouteFiles(root: string): string[] {
  const routes: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === "route.ts") routes.push(absolute);
    }
  };
  visit(root);
  return routes.sort();
}

function request(input: {
  method: string;
  origin?: string;
  fetchSite?: string;
  url?: string;
}): Request {
  const headers = new Headers();
  if (input.origin !== undefined) headers.set("Origin", input.origin);
  if (input.fetchSite !== undefined) {
    headers.set("Sec-Fetch-Site", input.fetchSite);
  }
  return new Request(
    input.url ?? "https://crm.stonegate.test/api/team/contacts/contact",
    { method: input.method, headers },
  );
}

describe("Site Team mutation origin boundary", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows safe %s requests without an Origin header",
    (method) => {
      expect(teamRequestRequiresOrigin(method)).toBe(false);
      expect(isSameOriginTeamRequest(request({ method }))).toBe(true);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "requires the exact Site origin for %s requests",
    (method) => {
      expect(teamRequestRequiresOrigin(method)).toBe(true);
      expect(
        isSameOriginTeamRequest(
          request({
            method,
            origin: "https://crm.stonegate.test",
            fetchSite: "same-origin",
          }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["missing", undefined, undefined],
    ["opaque", "null", undefined],
    ["malformed", "not a URL", undefined],
    ["cross-origin", "https://attacker.test", "cross-site"],
    ["same-site subdomain", "https://other.stonegate.test", "same-site"],
    ["credentialed", "https://user:secret@crm.stonegate.test", undefined],
    ["path-bearing", "https://crm.stonegate.test/path", undefined],
    ["query-bearing", "https://crm.stonegate.test?unsafe=1", undefined],
  ])("rejects a %s unsafe request origin", (_label, origin, fetchSite) => {
    expect(
      isSameOriginTeamRequest(request({ method: "POST", origin, fetchSite })),
    ).toBe(false);
  });

  it("enforces the origin boundary before session resolution", () => {
    const authSource = fs.readFileSync(
      path.resolve(SITE_TEAM_ROUTE_ROOT, "auth.ts"),
      "utf8",
    );
    const originGuard = authSource.indexOf("isSameOriginTeamRequest(request)");
    const sessionResolution = authSource.indexOf(
      "resolveTeamPrincipalFromRequest(request)",
      originGuard,
    );
    expect(originGuard).toBeGreaterThanOrEqual(0);
    expect(sessionResolution).toBeGreaterThan(originGuard);
    expect(authSource.slice(originGuard, sessionResolution)).toContain(
      'error: "forbidden"',
    );
  });

  it("routes every Site Team HTTP mutation through the shared principal and origin gate", () => {
    const uncovered: string[] = [];
    let mutationCount = 0;
    for (const absolute of listRouteFiles(SITE_TEAM_ROUTE_ROOT)) {
      const source = fs.readFileSync(absolute, "utf8");
      const exports = [...source.matchAll(UNSAFE_ROUTE_EXPORT)];
      mutationCount += exports.length;
      if (
        exports.length > 0 &&
        !source.includes("requireTeamPrincipal(") &&
        !source.includes("requireTeamRequestPrincipal(")
      ) {
        uncovered.push(path.relative(SITE_TEAM_ROUTE_ROOT, absolute));
      }
    }

    expect(mutationCount).toBeGreaterThanOrEqual(45);
    expect(uncovered).toEqual([]);
  });
});
