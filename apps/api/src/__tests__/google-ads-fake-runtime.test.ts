import { spawn } from "node:child_process";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 46_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const apiVersion = "v25";
const customerId = "9876543210";
const apiBase = `${origin}/${apiVersion}`;
const customerBase = `${apiBase}/customers/${customerId}`;
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Google Ads fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Google Ads fake did not become ready: ${stderr}`);
}

async function setScenario(
  operation: string,
  scenario: string,
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<Response> {
  return fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
}

function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer private-access-token-must-not-be-captured",
      "developer-token": "private-developer-token-must-not-be-captured",
      "login-customer-id": "1111111111",
      ...(init.headers ?? {}),
    },
  });
}

function search(query: string, signal?: AbortSignal): Promise<Response> {
  return providerFetch(`${customerBase}/googleAds:searchStream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/google-ads-fake/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-30_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5_000);
  });
  await waitUntilReady();
}, 10_000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    server.once("exit", () => resolveExit());
    server.kill("SIGTERM");
    setTimeout(resolveExit, 1_000).unref();
  });
});

beforeEach(async () => {
  stdout = "";
  stderr = "";
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
});

describe("local Google Ads fake runtime", () => {
  it("implements token, accessible-customer, four search, and mutation response shapes without retaining sensitive values", async () => {
    const clientSecret = "private-client-secret-must-not-be-captured";
    const refreshToken = "private-refresh-token-must-not-be-captured";
    const queryMarker = "private-query-marker-must-not-be-captured";
    const negativeKeyword = "private-negative-keyword-must-not-be-captured";

    const token = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "private-client-id",
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      access_token: "google-ads-e2e-access-token",
      expires_in: 3600,
    });

    const accessible = await providerFetch(
      `${apiBase}/customers:listAccessibleCustomers`,
    );
    expect(accessible.status).toBe(200);
    expect(await accessible.json()).toEqual({
      resourceNames: ["customers/0000000001"],
    });

    const queryCases = [
      [
        "conversion_actions",
        `SELECT conversion_action.id FROM conversion_action /* ${queryMarker} */`,
      ],
      [
        "campaign_metrics",
        `SELECT campaign.id FROM campaign /* ${queryMarker} */`,
      ],
      [
        "search_terms",
        `SELECT search_term_view.search_term FROM search_term_view /* ${queryMarker} */`,
      ],
      [
        "campaign_conversions",
        `SELECT campaign.id, segments.conversion_action FROM campaign /* ${queryMarker} */`,
      ],
    ] as const;
    for (const [, query] of queryCases) {
      const response = await search(query);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Array<{ results?: unknown[] }>;
      expect(Array.isArray(payload)).toBe(true);
      expect(payload[0]?.results?.length).toBeGreaterThan(0);
    }

    const mutation = await providerFetch(
      `${customerBase}/customerNegativeCriteria:mutate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operations: [
            {
              create: {
                keyword: { text: negativeKeyword, matchType: "EXACT" },
              },
            },
          ],
          partialFailure: false,
        }),
      },
    );
    expect(mutation.status).toBe(200);
    expect(await mutation.json()).toMatchObject({
      results: [
        {
          resourceName:
            "customers/0000000001/customerNegativeCriteria/9000000001",
        },
      ],
    });

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(evidence.requests.map((item) => item["operation"])).toEqual(
      expect.arrayContaining([
        "token",
        "accessible_customers",
        "search_stream",
        "mutate_negative_keyword",
      ]),
    );
    expect(
      evidence.requests
        .filter((item) => item["operation"] === "search_stream")
        .map((item) => item["queryKind"]),
    ).toEqual(expect.arrayContaining(queryCases.map(([kind]) => kind)));

    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      clientSecret,
      refreshToken,
      queryMarker,
      negativeKeyword,
      customerId,
      "1111111111",
      "private-access-token-must-not-be-captured",
      "private-developer-token-must-not-be-captured",
    ]) {
      expect(serialized).not.toContain(privateValue);
      expect(stdout).not.toContain(privateValue);
      expect(stderr).not.toContain(privateValue);
    }
  });

  it("covers 401, 403, 404, 409, 422, 429, and configurable 5xx", async () => {
    const cases = [
      ["token", "unauthorized", 401],
      ["accessible_customers", "forbidden", 403],
      ["search_stream", "not_found", 404],
      ["mutate_negative_keyword", "conflict", 409],
      ["search_stream", "unprocessable", 422],
      ["accessible_customers", "rate_limited", 429],
    ] as const;

    for (const [operation, scenario, status] of cases) {
      expect((await setScenario(operation, scenario)).status).toBe(200);
      const response =
        operation === "token"
          ? await fetch(`${origin}/token`, { method: "POST" })
          : operation === "accessible_customers"
            ? await providerFetch(
                `${apiBase}/customers:listAccessibleCustomers`,
              )
            : operation === "search_stream"
              ? await search("SELECT campaign.id FROM campaign")
              : await providerFetch(
                  `${customerBase}/customerNegativeCriteria:mutate`,
                  { method: "POST" },
                );
      expect(response.status).toBe(status);
    }

    await setScenario("search_stream", "provider_error", { status: 503 });
    expect((await search("SELECT campaign.id FROM campaign")).status).toBe(503);
    await setScenario("mutate_negative_keyword", "provider_error", {
      status: 502,
    });
    expect(
      (
        await providerFetch(`${customerBase}/customerNegativeCriteria:mutate`, {
          method: "POST",
        })
      ).status,
    ).toBe(502);
  });

  it("supports malformed, empty, timeout, and one-shot recovery scenarios", async () => {
    await setScenario("token", "malformed_json");
    const malformed = await fetch(`${origin}/token`, { method: "POST" });
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("{malformed-json");

    await setScenario("accessible_customers", "empty_success");
    const empty = await providerFetch(
      `${apiBase}/customers:listAccessibleCustomers`,
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");

    await setScenario("search_stream", "timeout", { delayMs: 200 });
    await expect(
      search("SELECT campaign.id FROM campaign", AbortSignal.timeout(25)),
    ).rejects.toThrow();

    await setScenario("mutate_negative_keyword", "conflict", { repeat: 1 });
    const mutationUrl = `${customerBase}/customerNegativeCriteria:mutate`;
    expect((await providerFetch(mutationUrl, { method: "POST" })).status).toBe(
      409,
    );
    expect((await providerFetch(mutationUrl, { method: "POST" })).status).toBe(
      200,
    );
  });

  it("bounds evidence and reset clears requests and scenarios", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          providerFetch(`${apiBase}/customers:listAccessibleCustomers`),
        ),
      );
    }
    const beforeReset = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: unknown[];
          retained: number;
          limit: number;
        }>,
    );
    expect(beforeReset.limit).toBe(100);
    expect(beforeReset.retained).toBe(100);
    expect(beforeReset.requests).toHaveLength(100);

    await setScenario("accessible_customers", "provider_error");
    await fetch(`${origin}/__control/reset`, { method: "POST" });
    const afterReset = await fetch(`${origin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: unknown[] }>,
    );
    expect(afterReset.requests).toEqual([]);
    expect(
      (await providerFetch(`${apiBase}/customers:listAccessibleCustomers`))
        .status,
    ).toBe(200);
  });
});
