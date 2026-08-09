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

describe("Google Ads provider source and E2E contracts", () => {
  it("routes every active server provider call through the typed SDK boundary", () => {
    const forbiddenApiHost = ["https://googleads", ".googleapis.com"].join("");
    const roots = ["apps/api", "apps/site", "scripts"].map((directory) =>
      join(REPOSITORY_ROOT, directory),
    );
    const violations = roots
      .flatMap(sourceFiles)
      .filter((file) => !file.includes("/__tests__/"))
      .filter((file) => readFileSync(file, "utf8").includes(forbiddenApiHost));
    expect(violations).toEqual([]);

    const adapter = read("apps/api/src/lib/google-ads-insights.ts");
    expect(adapter).toContain("resolveGoogleAdsTokenEndpoint(process.env)");
    expect(adapter.match(/resolveGoogleAdsApiEndpoint\(/gu)).toHaveLength(3);
    for (const operation of [
      'kind: "accessible_customers"',
      'kind: "search_stream"',
      'kind: "mutate_customer_negative_criteria"',
    ]) {
      expect(adapter).toContain(operation);
    }
  });

  it("never carries raw provider failures into status, logs, or persisted health", () => {
    const adapter = read("apps/api/src/lib/google-ads-insights.ts");
    const status = read("apps/api/app/api/admin/google/ads/status/route.ts");
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    expect(adapter).toContain("readonly failureCode: string");
    expect(adapter).not.toContain("readonly body: string");
    expect(status).not.toContain("error.body");
    expect(outbox).not.toContain("error.status}:${error.body");
    expect(outbox).toContain("error.status}:${error.failureCode");
    expect(adapter).toContain("await response.body?.cancel()");
  });

  it("rejects malformed or empty successful read shapes", () => {
    const adapter = read("apps/api/src/lib/google-ads-insights.ts");
    expect(adapter).toContain(
      'throw new Error("google_ads_accessible_customers_invalid_response")',
    );
    expect(adapter).toContain('throw new Error("google_ads_invalid_response")');
    expect(adapter).toContain(
      'failureCode: "google_ads_mutation_invalid_resource_name"',
    );
    expect(adapter).toContain("!/^customers\\/\\d{10}$/u.test(value)");
    expect(adapter).toContain("if (!Array.isArray(results))");
    expect(adapter).toContain("if (!isRecord(row))");
    expect(adapter).toContain(
      "match?.[1] === expectedCustomerId ? resourceName : null",
    );
  });

  it("wires the non-root fake to 127.0.0.1:4014 in every E2E surface", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("google-ads-fake:");
    expect(compose).toContain("context: ./google-ads-fake");
    expect(compose).toContain('"127.0.0.1:${GOOGLE_ADS_HTTP_PORT:-4014}:4014"');
    expect(read("devops/google-ads-fake/Dockerfile")).toContain("USER node");

    for (const envFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "GOOGLE_ADS_API_BASE_URL=http://127.0.0.1:4014",
      );
      expect(environment).toContain(
        "GOOGLE_ADS_TOKEN_URL=http://127.0.0.1:4014/token",
      );
      expect(environment).toContain(
        "GOOGLE_ADS_FAKE_CONTROL_URL=http://127.0.0.1:4014",
      );
    }
    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForGoogleAdsFake");
    expect(waitScript).toContain("getGoogleAdsProviderEndpoints");
  });

  it("keeps fake evidence bounded and free of sensitive provider values", () => {
    const fake = read("devops/google-ads-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).not.toMatch(
      /capturedRequests\.(?:push|unshift)\([^\n]*(?:body|query|token|customer|campaign|budget)/iu,
    );
    expect(fake).not.toContain("console.info(request.url");
    expect(fake).not.toContain("request.headers.authorization,");
    expect(fake).not.toContain('request.headers["developer-token"],');
  });

  it("keeps public browser measurement separate and absent from authenticated Team routes", () => {
    expect(read("apps/site/src/components/GoogleTag.tsx")).toContain(
      "www.googletagmanager.com/gtag/js",
    );
    expect(
      read("apps/api/src/__tests__/site-team-privacy-boundary.test.ts"),
    ).toContain('"googletagmanager.com"');
  });
});
