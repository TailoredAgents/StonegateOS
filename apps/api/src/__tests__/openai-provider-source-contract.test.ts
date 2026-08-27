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

describe("OpenAI provider source and E2E contracts", () => {
  it("routes every API, Site, and script call through the shared resolver", () => {
    const forbiddenProvider = ["https://api", ".openai.com"].join("");
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
        readFileSync(file, "utf8").includes("resolveOpenAiApiEndpoint"),
      );
    expect(callSiteFiles).toHaveLength(20);
    expect(callSiteFiles).toContain(
      join(REPOSITORY_ROOT, "apps/api/src/lib/expense-receipt-openai.ts"),
    );
    expect(callSiteFiles).toContain(
      join(REPOSITORY_ROOT, "apps/api/scripts/expense-receipt-benchmark.ts"),
    );
  });

  it("wires the loopback-only fake into Compose and every E2E environment", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("openai-fake:");
    expect(compose).toContain("context: ./openai-fake");
    expect(compose).toContain("HOST=0.0.0.0");
    expect(compose).toContain('"127.0.0.1:${OPENAI_HTTP_PORT:-4011}:4011"');

    for (const envFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "OPENAI_API_BASE_URL=http://127.0.0.1:4011/v1",
      );
      expect(environment).toContain(
        "OPENAI_FAKE_CONTROL_URL=http://127.0.0.1:4011",
      );
    }

    const example = read(".env.example");
    expect(example).toContain("OPENAI_API_BASE_URL=");
    expect(example).toContain("TEAM_CRM_AUDIT_MODE=0");
    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForOpenAiFake");
    expect(waitScript).toContain("getOpenAiApiBaseUrl");
    expect(waitScript).toContain("controlBase.origin !== providerBase.origin");
  });

  it("keeps fake captures bounded and metadata-only", () => {
    const fake = read("devops/openai-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).toContain("authorizationKind(request.headers.authorization)");
    expect(fake).not.toMatch(/capturedRequests\.(?:push|unshift)\([^\n]*body/u);
    expect(fake).not.toContain("console.info(raw");
  });
});
