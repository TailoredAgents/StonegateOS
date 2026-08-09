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

describe("Meta provider source and E2E contracts", () => {
  it("routes every Graph API call through the shared resolver", () => {
    const forbiddenProvider = ["https://graph", ".facebook.com"].join("");
    const roots = ["apps/api", "apps/site", "scripts"].map((directory) =>
      join(REPOSITORY_ROOT, directory),
    );
    const violations = roots
      .flatMap(sourceFiles)
      .filter((file) => !file.includes("/__tests__/"))
      .filter((file) => readFileSync(file, "utf8").includes(forbiddenProvider));
    expect(violations).toEqual([]);

    const callSiteFiles = roots
      .flatMap(sourceFiles)
      .filter((file) => !file.includes("/__tests__/"))
      .filter((file) =>
        readFileSync(file, "utf8").includes("resolveMetaGraphApiEndpoint"),
      );
    expect(
      callSiteFiles
        .map((file) => file.replace(`${REPOSITORY_ROOT}/`, ""))
        .sort(),
    ).toEqual([
      "apps/api/src/lib/facebook-webhooks.ts",
      "apps/api/src/lib/messaging.ts",
      "apps/api/src/lib/meta-ads-insights.ts",
      "apps/api/src/lib/outbox-processor.ts",
    ]);

    expect(read("apps/api/src/lib/meta-ads-insights.ts")).toContain(
      "validateMetaGraphPaginationUrl(json.paging.next, process.env)",
    );
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    expect(outbox).toContain("event_id: event.id");
    expect(outbox).toContain("meta_lead_event_invalid_response");
    expect(outbox).not.toContain("error: responseText");
    expect(outbox).not.toContain(
      "meta_ads_insights_failed:${error.status}:${error.body}",
    );
    expect(read("apps/api/src/lib/messaging.ts")).toContain(
      "facebook_dm_response_missing_message_id",
    );
    expect(read("apps/api/src/lib/messaging.ts")).not.toMatch(
      /fb_page_token_failed:\$\{response\.status\}:\$\{/u,
    );
    expect(read("apps/api/src/lib/meta-ads-insights.ts")).not.toContain(
      "readonly body",
    );
    const webhookAdapter = read("apps/api/src/lib/facebook-webhooks.ts");
    expect(webhookAdapter).not.toMatch(/body: result\.text/u);
    expect(webhookAdapter).not.toMatch(/body: .*Result\.(?:json|text)/u);
    expect(webhookAdapter).not.toMatch(
      /leadgen_fetch_failed:\$\{response\.status\}:\$\{/u,
    );
  });

  it("wires the loopback-only fake into Compose and every E2E environment", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("meta-fake:");
    expect(compose).toContain("context: ./meta-fake");
    expect(compose).toContain("HOST=0.0.0.0");
    expect(compose).toContain('"127.0.0.1:${META_HTTP_PORT:-4013}:4013"');

    for (const envFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "FACEBOOK_GRAPH_API_BASE_URL=http://127.0.0.1:4013",
      );
      expect(environment).toContain(
        "META_FAKE_CONTROL_URL=http://127.0.0.1:4013",
      );
    }

    const apiEnvironment = read("apps/api/.env.e2e.local");
    expect(apiEnvironment).toContain(
      "FB_MESSENGER_ACCESS_TOKEN=e2e-meta-system-token",
    );
    expect(apiEnvironment).toContain(
      "META_CONVERSIONS_TOKEN=e2e-meta-conversions-token",
    );

    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForMetaFake");
    expect(waitScript).toContain("getMetaGraphApiBaseUrl");
    expect(waitScript).toContain("controlBase.origin !== providerBase.origin");
    expect(read("tests/e2e/support/system-checks.ts")).toContain(
      'name: "meta-fake"',
    );
    expect(read("tests/e2e/support/meta.ts")).toContain("setMetaFakeScenario");
    expect(read("tests/e2e/global-setup.ts")).toContain("resetMetaFake");
    expect(read("tests/e2e/audit/global-setup.ts")).toContain("resetMetaFake");
  });

  it("keeps fake evidence bounded and content-free", () => {
    const fake = read("devops/meta-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).toContain("recipientIdHash: safeHash(recipientId)");
    expect(fake).not.toContain("recipientIdSuffix");
    expect(fake).not.toContain("targetIdSuffix");
    expect(fake).not.toMatch(/capturedRequests\.(?:push|unshift)\([^\n]*body/u);
    expect(fake).not.toContain("rawBody:");
    expect(fake).not.toContain("messageBody:");
    expect(fake).not.toContain("mediaUrl:");
    expect(fake).not.toContain("accessToken:");
  });

  it("documents the provider safety and scenario surface", () => {
    const docs = read("devops/meta-fake/README.md");
    for (const scenario of [
      "oauth_denied",
      "permission_denied",
      "not_found",
      "conflict",
      "rate_limited",
      "provider_error",
      "malformed_json",
      "empty_success",
      "timeout",
      "media_partial_failure",
    ]) {
      expect(docs).toContain(scenario);
    }
    expect(docs).toContain("never retains access-token values");
  });
});
