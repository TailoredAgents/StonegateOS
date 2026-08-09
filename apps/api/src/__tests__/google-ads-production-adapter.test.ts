import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  applyCustomerNegativeKeyword,
  getGoogleAdsAccessToken,
  googleAdsSearchStream,
  GoogleAdsApiError,
  GoogleAdsMutationDispatchError,
  listGoogleAdsAccessibleCustomers,
} from "@/lib/google-ads-insights";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 47_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof spawn>;
let stderr = "";

const GOOGLE_ADS_ENVIRONMENT_KEYS = [
  "E2E_RUN_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_API_VERSION",
  "GOOGLE_ADS_API_BASE_URL",
  "GOOGLE_ADS_TOKEN_URL",
] as const;
const originalEnvironment = Object.fromEntries(
  GOOGLE_ADS_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof GOOGLE_ADS_ENVIRONMENT_KEYS)[number], string | undefined>;

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Google Ads fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Google Ads fake did not become ready: ${stderr}`);
}

async function setScenario(
  operation: string,
  scenario: string,
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<void> {
  const response = await fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  process.env["E2E_RUN_ID"] = "google-ads-production-adapter";
  process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] = "e2e-google-ads-developer-token";
  process.env["GOOGLE_ADS_CLIENT_ID"] = "e2e-google-ads-client";
  process.env["GOOGLE_ADS_CLIENT_SECRET"] = "e2e-google-ads-client-secret";
  process.env["GOOGLE_ADS_REFRESH_TOKEN"] = "e2e-google-ads-refresh-token";
  process.env["GOOGLE_ADS_CUSTOMER_ID"] = "0000000001";
  process.env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] = "0000000002";
  process.env["GOOGLE_ADS_API_VERSION"] = "v25";
  process.env["GOOGLE_ADS_API_BASE_URL"] = origin;
  process.env["GOOGLE_ADS_TOKEN_URL"] = `${origin}/token`;

  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/google-ads-fake/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5_000);
  });
  await waitUntilReady();
}, 10_000);

afterAll(async () => {
  for (const key of GOOGLE_ADS_ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    server.once("exit", () => resolveExit());
    server.kill("SIGTERM");
    setTimeout(resolveExit, 1_000).unref();
  });
});

beforeEach(async () => {
  process.env["GOOGLE_ADS_API_BASE_URL"] = origin;
  process.env["GOOGLE_ADS_TOKEN_URL"] = `${origin}/token`;
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

describe("production Google Ads adapter against deterministic provider", () => {
  it("uses the configured boundary for token, discovery, every search shape, and the active mutation", async () => {
    await setScenario("token", "rate_limited", { repeat: 1 });
    await expect(getGoogleAdsAccessToken()).rejects.toMatchObject({
      status: 429,
      failureCode: "google_ads_provider_http_429",
    });

    const accessToken = await getGoogleAdsAccessToken();
    expect(accessToken).toBe("google-ads-e2e-access-token");
    await expect(
      listGoogleAdsAccessibleCustomers({ accessToken }),
    ).resolves.toEqual(["customers/0000000001"]);

    const queries = [
      "SELECT conversion_action.id FROM conversion_action",
      "SELECT campaign.id FROM campaign",
      "SELECT search_term_view.search_term FROM search_term_view",
      "SELECT campaign.id, segments.conversion_action FROM campaign",
    ];
    for (const query of queries) {
      const rows = await googleAdsSearchStream({
        customerId: "0000000001",
        accessToken,
        query,
      });
      expect(rows.length).toBeGreaterThan(0);
    }

    await expect(
      applyCustomerNegativeKeyword({
        customerId: "0000000001",
        accessToken,
        term: '"deterministic negative phrase"',
      }),
    ).resolves.toEqual({
      resourceName: "customers/0000000001/customerNegativeCriteria/9000000001",
      term: "deterministic negative phrase",
      matchType: "PHRASE",
      providerStatus: 200,
    });

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<{ operation: string; queryKind: string | null }>;
        }>,
    );
    expect(evidence.requests.map((request) => request.operation)).toEqual(
      expect.arrayContaining([
        "token",
        "accessible_customers",
        "search_stream",
        "mutate_negative_keyword",
      ]),
    );
    expect(
      evidence.requests
        .filter((request) => request.operation === "search_stream")
        .map((request) => request.queryKind),
    ).toEqual(
      expect.arrayContaining([
        "conversion_actions",
        "campaign_metrics",
        "search_terms",
        "campaign_conversions",
      ]),
    );
  });

  it("rejects malformed, empty, and structurally invalid 2xx responses", async () => {
    for (const scenario of [
      "malformed_json",
      "empty_success",
      "invalid_success",
    ] as const) {
      await setScenario("token", scenario);
      await expect(getGoogleAdsAccessToken()).rejects.toThrow(
        "google_ads_token_missing",
      );
    }
    await setScenario("token", "success");

    const accessToken = await getGoogleAdsAccessToken();
    for (const scenario of [
      "malformed_json",
      "empty_success",
      "invalid_success",
    ] as const) {
      await setScenario("accessible_customers", scenario);
      await expect(
        listGoogleAdsAccessibleCustomers({ accessToken }),
      ).rejects.toThrow("google_ads_accessible_customers_invalid_response");

      await setScenario("search_stream", scenario);
      await expect(
        googleAdsSearchStream({
          customerId: "0000000001",
          accessToken,
          query: "SELECT campaign.id FROM campaign",
        }),
      ).rejects.toThrow("google_ads_invalid_response");

      await setScenario("mutate_negative_keyword", scenario);
      const mutationError = await applyCustomerNegativeKeyword({
        customerId: "0000000001",
        accessToken,
        term: "invalid-success-shape",
      }).catch((error: unknown) => error);
      expect(mutationError).toBeInstanceOf(GoogleAdsMutationDispatchError);
      expect(mutationError).toMatchObject({ certainty: "uncertain" });
    }
  });

  it("preserves valid empty read results while rejecting invalid successful shapes", async () => {
    const accessToken = await getGoogleAdsAccessToken();
    await setScenario("accessible_customers", "no_results");
    await expect(
      listGoogleAdsAccessibleCustomers({ accessToken }),
    ).resolves.toEqual([]);

    await setScenario("search_stream", "no_results");
    await expect(
      googleAdsSearchStream({
        customerId: "0000000001",
        accessToken,
        query: "SELECT campaign.id FROM campaign",
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    ["a chunk without results", [{}]],
    ["a non-object row", [{ results: [null] }]],
  ])("rejects SearchStream success containing %s", async (_label, payload) => {
    const providerFetch = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(
        googleAdsSearchStream({
          customerId: "0000000001",
          accessToken: "google-ads-e2e-access-token",
          query: "SELECT campaign.id FROM campaign",
        }),
      ).rejects.toThrow("google_ads_invalid_response");
    } finally {
      providerFetch.mockRestore();
    }
  });

  it.each([
    [
      "a different customer",
      {
        results: [
          {
            resourceName:
              "customers/9999999999/customerNegativeCriteria/9000000001",
          },
        ],
      },
    ],
    [
      "a nonnumeric criterion ID",
      {
        results: [
          {
            resourceName:
              "customers/0000000001/customerNegativeCriteria/not-numeric",
          },
        ],
      },
    ],
    [
      "multiple receipts for one operation",
      {
        results: [
          {
            resourceName:
              "customers/0000000001/customerNegativeCriteria/9000000001",
          },
          {
            resourceName:
              "customers/0000000001/customerNegativeCriteria/9000000002",
          },
        ],
      },
    ],
  ])("rejects a mutation receipt for %s", async (_label, payload) => {
    const providerFetch = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(
        applyCustomerNegativeKeyword({
          customerId: "0000000001",
          accessToken: "google-ads-e2e-access-token",
          term: "invalid-resource-shape",
        }),
      ).rejects.toMatchObject({
        certainty: "uncertain",
        failureCode: "google_ads_mutation_invalid_resource_name",
      });
    } finally {
      providerFetch.mockRestore();
    }
  });

  it("fails closed before public-provider fallback and exposes only safe error codes", async () => {
    const accessToken = await getGoogleAdsAccessToken();
    await setScenario("accessible_customers", "forbidden");
    const providerError = await listGoogleAdsAccessibleCustomers({
      accessToken,
    }).catch((error: unknown) => error);
    expect(providerError).toBeInstanceOf(GoogleAdsApiError);
    expect(providerError).toMatchObject({
      status: 403,
      failureCode: "google_ads_provider_http_403",
    });
    expect(providerError).not.toHaveProperty("body");

    process.env["GOOGLE_ADS_API_BASE_URL"] = "https://googleads.googleapis.com";
    await expect(
      listGoogleAdsAccessibleCustomers({ accessToken }),
    ).rejects.toThrow(
      "GOOGLE_ADS_API_BASE_URL must target a loopback service during E2E or CRM audit runs",
    );
    process.env["GOOGLE_ADS_API_BASE_URL"] = origin;

    process.env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] = "bad/0000000002";
    await expect(
      listGoogleAdsAccessibleCustomers({ accessToken }),
    ).rejects.toThrow("google_ads_invalid_login_customer_id");
    process.env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] = "0000000002";

    process.env["GOOGLE_ADS_CUSTOMER_ID"] = "bad/0000000001";
    await expect(
      listGoogleAdsAccessibleCustomers({ accessToken }),
    ).rejects.toThrow("google_ads_invalid_customer_id");
    process.env["GOOGLE_ADS_CUSTOMER_ID"] = "0000000001";

    process.env["GOOGLE_ADS_TOKEN_URL"] = "https://oauth2.googleapis.com/token";
    await expect(getGoogleAdsAccessToken()).rejects.toThrow(
      "GOOGLE_ADS_TOKEN_URL must target a loopback service during E2E or CRM audit runs",
    );
  });
});
