import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  consoleHealthIssue,
  externalRequestHealthIssue,
  failedRequestHealthIssue,
  isActiveLoadingText,
  OWNER_ALL_TAB_HEALTH_ALLOWANCES,
  responseHealthIssue,
  safeAuditUrl,
  surfaceHealthAllowanceViolations,
  unexpectedSurfaceHealthIssues,
  type SurfaceHealthAllowance,
  type SurfaceHealthIssue,
} from "../../../../tests/e2e/audit/surface-health";

const BASE_URL = "http://localhost:3000";

describe("Team audit surface health", () => {
  it("has no hidden normal-state error allowances", () => {
    expect(OWNER_ALL_TAB_HEALTH_ALLOWANCES).toEqual([]);
  });

  it("keeps the owner smoke wired to settling, health, and strict document checks", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "../../tests/e2e/audit/team-console-audit.spec.ts",
      ),
      "utf8",
    );
    const ownerSmoke = source.slice(
      source.indexOf('test.describe("owner all-tab smoke"'),
      source.indexOf('test.describe("navigation, aliases, and compatibility"'),
    );

    expect(ownerSmoke).toContain("monitorTeamSurfaceHealth(");
    expect(ownerSmoke).toContain("waitForTeamSurfaceToSettle(page)");
    expect(ownerSmoke).toContain("await health.assertHealthy(testInfo)");
    expect(ownerSmoke).toContain("await health.stop()");
    expect(ownerSmoke).toContain("toBeLessThan(400)");
  });

  it("records console errors and assertions but ignores routine console output", () => {
    expect(consoleHealthIssue("log", "hydrated")).toBeNull();
    expect(consoleHealthIssue("warning", "informational warning")).toBeNull();
    expect(consoleHealthIssue("error", "render failed")).toMatchObject({
      kind: "console_error",
      detail: "render failed",
    });
    expect(consoleHealthIssue("assert", "invariant failed")).toMatchObject({
      kind: "console_error",
      detail: "invariant failed",
    });
  });

  it("recognizes real loading copy without confusing Stonegate service language", () => {
    for (const text of [
      "Loading media analysis…",
      "Checking availability...",
      "Booking source data is loading.",
      "Results are loading",
    ]) {
      expect(isActiveLoadingText(text)).toBe(true);
    }
    for (const text of [
      "Final price is confirmed before loading starts.",
      "This includes loading, haul-away, disposal, and cleanup.",
      "Loaded 25 contacts.",
      "New inbox activity is ready.",
    ]) {
      expect(isActiveLoadingText(text)).toBe(false);
    }
  });

  it("fails on same-origin transport and HTTP errors only", () => {
    expect(
      failedRequestHealthIssue(
        BASE_URL,
        `${BASE_URL}/api/team/inbox?contactId=private`,
        "GET",
        "net::ERR_CONNECTION_RESET",
      ),
    ).toEqual({
      kind: "same_origin_request_failed",
      detail: "net::ERR_CONNECTION_RESET",
      method: "GET",
      url: `${BASE_URL}/api/team/inbox`,
    });
    expect(
      responseHealthIssue(
        BASE_URL,
        `${BASE_URL}/api/team/contacts?email=private@example.com`,
        "GET",
        503,
      ),
    ).toEqual({
      kind: "same_origin_http_error",
      detail: "HTTP 503",
      method: "GET",
      status: 503,
      url: `${BASE_URL}/api/team/contacts`,
    });
    expect(
      responseHealthIssue(BASE_URL, `${BASE_URL}/team`, "GET", 399),
    ).toBeNull();
    expect(
      failedRequestHealthIssue(
        BASE_URL,
        "http://127.0.0.1:4011/v1/provider",
        "POST",
        "failed",
      ),
    ).toBeNull();
  });

  it("blocks cross-origin browser traffic while allowing non-network URLs", () => {
    expect(
      externalRequestHealthIssue(
        BASE_URL,
        "https://analytics.example.test/collect?customer=private",
        "POST",
      ),
    ).toEqual({
      kind: "external_request",
      detail: "Browser traffic outside the audited Site origin was blocked.",
      method: "POST",
      url: "https://analytics.example.test/collect",
    });
    expect(
      externalRequestHealthIssue(BASE_URL, `${BASE_URL}/team`, "GET"),
    ).toBeNull();
    expect(
      externalRequestHealthIssue(BASE_URL, "data:image/png;base64,AAAA", "GET"),
    ).toBeNull();
  });

  it("redacts query strings, fragments, emails, credentials, and long diagnostics", () => {
    expect(
      safeAuditUrl(
        `${BASE_URL}/api/team/inbox?email=private@example.com#private`,
      ),
    ).toBe(`${BASE_URL}/api/team/inbox`);
    const issue = consoleHealthIssue(
      "error",
      `Request ${BASE_URL}/api/team/inbox?email=private@example.com failed for private@example.com token=private-value ${"x".repeat(700)}`,
    );
    expect(issue?.detail).not.toContain("private@example.com");
    expect(issue?.detail).not.toContain("private-value");
    expect(issue?.detail).not.toContain("?email=");
    expect(issue?.detail.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("requires an allowance to match every declared field", () => {
    const issue: SurfaceHealthIssue = {
      kind: "same_origin_http_error",
      detail: "HTTP 404",
      method: "GET",
      status: 404,
      url: `${BASE_URL}/api/team/optional-panel`,
    };
    const exact: SurfaceHealthAllowance = {
      kind: "same_origin_http_error",
      reason: "Documented optional panel is absent in this fixture.",
      method: "GET",
      pathname: "/api/team/optional-panel",
      status: 404,
      detail: /^HTTP 404$/u,
    };
    expect(unexpectedSurfaceHealthIssues([issue], [exact])).toEqual([]);
    expect(surfaceHealthAllowanceViolations([exact])).toEqual([]);
    expect(
      unexpectedSurfaceHealthIssues(
        [issue],
        [{ ...exact, pathname: "/api/team/different-panel" }],
      ),
    ).toEqual([issue]);
  });

  it("rejects undocumented or blanket allowances before a page opens", () => {
    expect(
      surfaceHealthAllowanceViolations([
        { kind: "console_error", reason: "", detail: /anything/u },
        {
          kind: "same_origin_http_error",
          reason: "Too broad",
          pathname: "/api/team/optional-panel",
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "allowance 1 (console_error) must document a reason.",
        "allowance 1 (console_error) detail must be anchored and must not be global or sticky.",
        "allowance 2 (same_origin_http_error) must declare an exact method and pathname.",
        "allowance 2 (same_origin_http_error) must declare an exact HTTP status.",
      ]),
    );
  });
});
