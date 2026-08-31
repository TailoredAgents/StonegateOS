import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createSquarePartnerHostedCheckoutProvider } from "@/lib/partner-hosted-checkout-provider";

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
  it("creates a hosted payment link without capturing credentials or payment data", async () => {
    const privateAccessToken =
      "private-square-token-for-hosted-checkout-must-not-be-captured";
    const privateIntentId = "22222222-2222-4222-8222-222222222222";
    const privateInvoiceId = "33333333-3333-4333-8333-333333333333";
    const provider = createSquarePartnerHostedCheckoutProvider({
      accessToken: privateAccessToken,
      locationId: "location-e2e-0001",
      environment: {
        NODE_ENV: "test",
        E2E_RUN_ID: "partner-hosted-checkout",
        SQUARE_ENVIRONMENT: "sandbox",
        SQUARE_API_BASE_URL: origin,
      },
    });

    await expect(
      provider.createHostedCheckout({
        intentId: privateIntentId,
        invoiceId: privateInvoiceId,
        invoiceNumber: "INV-E2E-001",
        amountMinor: 12_500,
        currency: "USD",
        redirectUrl:
          "https://partners.example.test/partners/billing?payment=return",
      }),
    ).resolves.toEqual({
      provider: "square",
      providerLinkId: "payment-link-e2e-0001",
      providerOrderId: "order-e2e-0001",
      url: "https://sandbox.square.link/u/e2e-checkout",
      createdAt: "2026-08-30T12:00:01.000Z",
    });

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(evidence.requests[0]).toEqual(
      expect.objectContaining({
        operation: "create_payment_link",
        method: "POST",
        authorization: "bearer",
        squareVersion: "present",
        idempotencyKeyPresent: true,
        quickPayPresent: true,
        paymentNotePresent: true,
        rawPaymentSourcePresent: false,
      }),
    );
    const retainedEvidence = `${JSON.stringify(evidence)}${stdout}${stderr}`;
    expect(retainedEvidence).not.toContain(privateAccessToken);
    expect(retainedEvidence).not.toContain(privateIntentId);
    expect(retainedEvidence).not.toContain(privateInvoiceId);

    expect(
      (
        await setScenario("create_payment_link", "invalid_success", {
          repeat: 1,
        })
      ).ok,
    ).toBe(true);
    await expect(
      provider.createHostedCheckout({
        intentId: "44444444-4444-4444-8444-444444444444",
        invoiceId: privateInvoiceId,
        invoiceNumber: "INV-E2E-002",
        amountMinor: 5_000,
        currency: "USD",
        redirectUrl: "https://partners.example.test/partners/billing",
      }),
    ).rejects.toMatchObject({
      code: "provider_invalid_response",
      retryable: true,
    });
  });

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
