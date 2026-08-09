import { spawn } from "node:child_process";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 49_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Square fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Square fake did not become ready: ${stderr}`);
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

function providerFetch(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: {
      Authorization: "Bearer private-square-token-must-not-be-captured",
      "Square-Version": "2026-07-15",
    },
    signal,
  });
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/square-fake/server.mjs")],
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
  expect(
    (await fetch(`${origin}/__control/reset`, { method: "POST" })).ok,
  ).toBe(true);
});

describe("local Square fake runtime", () => {
  it("implements all five active provider reads with metadata-only evidence", async () => {
    const privateOrderId = "private-order-id-must-not-be-captured";
    const privatePaymentId = "private-payment-id-must-not-be-captured";
    const privateRefundId = "private-refund-id-must-not-be-captured";
    const privateLocationId = "private-location-id-must-not-be-captured";

    for (const path of [
      `/v2/orders/${privateOrderId}`,
      `/v2/payments/${privatePaymentId}`,
      `/v2/refunds/${privateRefundId}`,
      `/v2/payments?location_id=${privateLocationId}&begin_time=2026-08-01T00%3A00%3A00Z&end_time=2026-08-09T00%3A00%3A00Z`,
      `/v2/refunds?location_id=${privateLocationId}&begin_time=2026-08-01T00%3A00%3A00Z&end_time=2026-08-09T00%3A00%3A00Z`,
    ]) {
      const response = await providerFetch(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeTruthy();
    }

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(evidence.requests.map((item) => item["operation"])).toEqual(
      expect.arrayContaining([
        "retrieve_order",
        "retrieve_payment",
        "retrieve_refund",
        "list_payments",
        "list_refunds",
      ]),
    );
    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      privateOrderId,
      privatePaymentId,
      privateRefundId,
      privateLocationId,
      "private-square-token-must-not-be-captured",
      "4242",
      "e2e-receipt",
      "e2e-next-page",
    ]) {
      expect(serialized).not.toContain(privateValue);
      expect(stdout).not.toContain(privateValue);
      expect(stderr).not.toContain(privateValue);
    }
  });

  it("covers 401, 403, 404, 409, 422, 429, and configurable 5xx", async () => {
    const cases = [
      ["retrieve_order", "unauthorized", "/v2/orders/order", 401],
      ["retrieve_payment", "forbidden", "/v2/payments/payment", 403],
      ["retrieve_refund", "not_found", "/v2/refunds/refund", 404],
      ["list_payments", "conflict", "/v2/payments", 409],
      ["list_refunds", "unprocessable", "/v2/refunds", 422],
      ["retrieve_order", "rate_limited", "/v2/orders/order", 429],
    ] as const;
    for (const [operation, scenario, path, status] of cases) {
      expect((await setScenario(operation, scenario)).ok).toBe(true);
      expect((await providerFetch(path)).status).toBe(status);
    }
    await setScenario("retrieve_payment", "provider_error", { status: 503 });
    expect((await providerFetch("/v2/payments/payment")).status).toBe(503);
  });

  it("supports malformed, empty, timeout, and one-shot recovery", async () => {
    await setScenario("retrieve_order", "malformed_json");
    expect(await (await providerFetch("/v2/orders/order")).text()).toBe(
      "{malformed",
    );
    await setScenario("retrieve_payment", "empty_success");
    expect(await (await providerFetch("/v2/payments/payment")).text()).toBe("");
    await setScenario("retrieve_refund", "timeout", { delayMs: 200 });
    await expect(
      providerFetch("/v2/refunds/refund", AbortSignal.timeout(25)),
    ).rejects.toThrow();

    await setScenario("list_payments", "conflict", { repeat: 1 });
    expect((await providerFetch("/v2/payments")).status).toBe(409);
    expect((await providerFetch("/v2/payments")).status).toBe(200);
  });

  it("bounds evidence and reset clears requests and scenarios", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () => providerFetch("/v2/payments")),
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

    await setScenario("list_payments", "provider_error");
    await fetch(`${origin}/__control/reset`, { method: "POST" });
    const afterReset = await fetch(`${origin}/__control/requests`).then(
      (response) => response.json() as Promise<{ requests: unknown[] }>,
    );
    expect(afterReset.requests).toEqual([]);
    expect((await providerFetch("/v2/payments")).status).toBe(200);
  });
});
