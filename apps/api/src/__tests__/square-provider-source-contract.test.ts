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

describe("Square provider source and E2E contracts", () => {
  it("routes every active server-side Square HTTP call through the SDK boundary", () => {
    const roots = ["apps/api", "apps/site", "scripts"].map((directory) =>
      join(REPOSITORY_ROOT, directory),
    );
    for (const providerHost of [
      "https://connect.squareup.com",
      "https://connect.squareupsandbox.com",
    ]) {
      const violations = roots
        .flatMap(sourceFiles)
        .filter((file) => !file.includes("/__tests__/"))
        .filter((file) => readFileSync(file, "utf8").includes(providerHost));
      expect(violations).toEqual([]);
    }

    const adapter = read("apps/api/src/lib/square-client.ts");
    expect(adapter).toContain("resolveSquareApiEndpoint(");
    for (const operation of [
      '{ kind: "order", orderId }',
      '{ kind: "payment", paymentId }',
      '{ kind: "refund", refundId }',
      '{ kind: "payments" }',
      '{ kind: "refunds" }',
    ]) {
      expect(adapter).toContain(operation);
    }
  });

  it("bounds provider reads and exposes safe failures without raw bodies", () => {
    const adapter = read("apps/api/src/lib/square-client.ts");
    expect(adapter).toContain("MAX_SQUARE_RESPONSE_BYTES");
    expect(adapter).toContain("AbortSignal.timeout(timeoutMs)");
    expect(adapter).toContain("await response.body?.cancel()");
    expect(adapter).toContain("readonly failureCode: string");
    expect(adapter).not.toContain("readonly details: unknown");
    expect(adapter).not.toContain("response.text()");
  });

  it("wires a non-root fake to 127.0.0.1:4015 in every E2E surface", () => {
    const compose = read("devops/docker-compose.yml");
    expect(compose).toContain("square-fake:");
    expect(compose).toContain("context: ./square-fake");
    expect(compose).toContain('"127.0.0.1:${SQUARE_HTTP_PORT:-4015}:4015"');
    expect(read("devops/square-fake/Dockerfile")).toContain("USER node");

    for (const envFile of [
      ".env.e2e",
      "apps/api/.env.e2e.local",
      "apps/site/.env.e2e.local",
    ]) {
      const environment = read(envFile);
      expect(environment).toContain(
        "SQUARE_API_BASE_URL=http://127.0.0.1:4015",
      );
      expect(environment).toContain(
        "SQUARE_FAKE_CONTROL_URL=http://127.0.0.1:4015",
      );
    }
    const waitScript = read("scripts/wait-for-e2e-services.ts");
    expect(waitScript).toContain("waitForSquareFake");
    expect(waitScript).toContain("getSquareApiBaseUrl");
  });

  it("keeps captured evidence bounded and free of sensitive Square values", () => {
    const fake = read("devops/square-fake/server.mjs");
    expect(fake).toContain("MAX_CAPTURED_REQUESTS = 100");
    expect(fake).toContain('const host = process.env["HOST"] === "0.0.0.0"');
    expect(fake).not.toMatch(
      /capturedRequests\.(?:push|unshift)\([^\n]*(?:body|token|resourceId|locationId|last_4|receipt)/iu,
    );
    expect(fake).not.toContain("console.info(request.url");
    expect(fake).not.toContain("request.headers.authorization,");
    expect(fake).not.toContain("console.error(error");
  });
});
