import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

function sourceFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    if ([".next", "dist", "node_modules"].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      results.push(...sourceFiles(absolute));
    } else if (/\.(?:js|mjs|ts|tsx)$/u.test(entry)) {
      results.push(absolute);
    }
  }
  return results;
}

function read(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Google Calendar provider source and E2E contracts", () => {
  it("routes every production Calendar API call through the shared resolver", () => {
    const forbiddenCalendarApi = [
      "https://www.googleapis.com",
      "/calendar/v3",
    ].join("");
    const productionRoots = ["apps/api", "apps/site", "scripts"].map(
      (directory) => join(REPOSITORY_ROOT, directory),
    );
    const violations = productionRoots
      .flatMap(sourceFiles)
      .filter((file) => !file.includes("/__tests__/"))
      .filter((file) =>
        readFileSync(file, "utf8").includes(forbiddenCalendarApi),
      );
    expect(violations).toEqual([]);

    const calendarAdapterFiles = [
      "apps/api/src/lib/calendar.ts",
      "apps/api/src/lib/calendar-sync.ts",
      "apps/api/app/api/admin/calendar/feed/route.ts",
    ];
    for (const file of calendarAdapterFiles) {
      expect(read(file)).toContain("resolveGoogleCalendarApiEndpoint");
    }
    expect(read("apps/api/src/lib/calendar.ts")).toContain(
      "resolveGoogleCalendarTokenEndpoint",
    );
    expect(read("apps/api/app/api/admin/calendar/feed/route.ts")).toContain(
      "AbortSignal.timeout(5_000)",
    );
    for (const file of [
      "apps/api/src/lib/calendar.ts",
      "apps/api/src/lib/calendar-sync.ts",
    ]) {
      const adapter = read(file);
      expect(adapter).not.toMatch(/response\.text\(\)/u);
      expect(adapter).not.toContain("error: String(error)");
    }
    expect(read("apps/api/src/lib/calendar.ts")).toContain(
      "parseGoogleCalendarEventMutationResponse",
    );
    expect(read("apps/api/src/lib/calendar-sync.ts")).toContain(
      "parseGoogleCalendarEventListResponse",
    );
    expect(read("apps/api/app/api/admin/calendar/feed/route.ts")).toContain(
      "parseExternalGoogleEvents",
    );
  });

  it("wires one loopback fake into Compose and every E2E environment", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("google-calendar-fake:");
    expect(compose).toContain("context: ./google-calendar-fake");
    expect(compose).toContain("HOST=0.0.0.0");
    expect(compose).toContain(
      '"127.0.0.1:${GOOGLE_CALENDAR_HTTP_PORT:-4012}:4012"',
    );

    for (const envFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "GOOGLE_CALENDAR_API_BASE_URL=http://127.0.0.1:4012/calendar/v3",
      );
      expect(environment).toContain(
        "GOOGLE_CALENDAR_TOKEN_URL=http://127.0.0.1:4012/token",
      );
      expect(environment).toContain(
        "GOOGLE_CALENDAR_FAKE_CONTROL_URL=http://127.0.0.1:4012",
      );
    }

    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForGoogleCalendarFake");
    expect(waitScript).toContain("getGoogleCalendarProviderEndpoints");
    expect(waitScript).toContain(
      "controlBase.origin !== endpoints.tokenUrl.origin",
    );
  });

  it("keeps fake request evidence bounded and metadata-only", () => {
    const fake = read("devops/google-calendar-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).toContain("authorizationKind(request.headers.authorization)");
    expect(fake).not.toMatch(
      /capturedRequests\.(?:push|unshift)\([^\n]*(?:body|description|attendee|address)/u,
    );
    expect(fake).not.toContain("request.headers.authorization,");
    expect(fake).not.toContain("console.info(request.url");
  });

  it("documents and guards all active operations and failure modes", () => {
    const fake = read("devops/google-calendar-fake/server.mjs");
    for (const operation of [
      "token",
      "create",
      "list",
      "get",
      "update",
      "delete",
      "watch",
    ]) {
      expect(fake).toContain(`"${operation}"`);
    }
    for (const scenario of [
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "rate_limited",
      "provider_error",
      "malformed_json",
      "empty_success",
      "timeout",
    ]) {
      expect(fake).toContain(`"${scenario}"`);
    }
  });
});
