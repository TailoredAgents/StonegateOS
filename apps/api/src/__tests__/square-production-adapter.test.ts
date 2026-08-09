import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  getSquareOrder,
  getSquarePayment,
  getSquareRefund,
  listSquarePayments,
  listSquareRefunds,
  retrieveAndVerifySquarePayment,
  SquareApiError,
} from "@/lib/square-client";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 50_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const orderId = "order-e2e-0001";
const paymentId = "payment-e2e-0001";
const refundId = "refund-e2e-0001";
const locationId = "location-e2e-0001";
const attemptId = "11111111-1111-4111-8111-111111111111";
let server: ReturnType<typeof spawn>;
let stderr = "";

const SQUARE_ENVIRONMENT_KEYS = [
  "E2E_RUN_ID",
  "SQUARE_ENVIRONMENT",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_API_BASE_URL",
] as const;
const originalEnvironment = Object.fromEntries(
  SQUARE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof SQUARE_ENVIRONMENT_KEYS)[number], string | undefined>;

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
): Promise<void> {
  const response = await fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
  expect(response.status).toBe(200);
}

function listWindow() {
  return {
    locationId,
    beginTime: new Date("2026-08-01T00:00:00.000Z"),
    endTime: new Date("2026-08-09T00:00:00.000Z"),
  };
}

beforeAll(async () => {
  process.env["E2E_RUN_ID"] = "square-production-adapter";
  process.env["SQUARE_ENVIRONMENT"] = "sandbox";
  process.env["SQUARE_ACCESS_TOKEN"] = "e2e-square-access-token";
  process.env["SQUARE_LOCATION_ID"] = locationId;
  process.env["SQUARE_API_BASE_URL"] = origin;

  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/square-fake/server.mjs")],
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
  for (const key of SQUARE_ENVIRONMENT_KEYS) {
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
  process.env["SQUARE_API_BASE_URL"] = origin;
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.status).toBe(200);
});

describe("production Square adapter against deterministic provider", () => {
  it("uses the configured boundary for all retrieval, listing, and verification paths", async () => {
    await expect(getSquareOrder(orderId)).resolves.toMatchObject({
      id: orderId,
      location_id: locationId,
    });
    await expect(getSquarePayment(paymentId)).resolves.toMatchObject({
      id: paymentId,
      order_id: orderId,
    });
    await expect(getSquareRefund(refundId)).resolves.toMatchObject({
      id: refundId,
      payment_id: paymentId,
    });
    await expect(listSquarePayments(listWindow())).resolves.toHaveLength(2);
    await expect(listSquareRefunds(listWindow())).resolves.toHaveLength(2);
    await expect(
      retrieveAndVerifySquarePayment({
        orderId,
        expectedAttemptId: attemptId,
        expectedJobAmountCents: 10_000,
        expectedLocationId: locationId,
      }),
    ).resolves.toMatchObject({
      providerOrderId: orderId,
      providerPaymentId: paymentId,
      totalAmountCents: 12_000,
      refundedAmountCents: 0,
    });

    const evidence = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<{ operation: string }>;
        }>,
    );
    expect(evidence.requests.map((request) => request.operation)).toEqual(
      expect.arrayContaining([
        "retrieve_order",
        "retrieve_payment",
        "retrieve_refund",
        "list_payments",
        "list_refunds",
      ]),
    );
  });

  it.each([
    ["retrieve_order", () => getSquareOrder(orderId)],
    ["retrieve_payment", () => getSquarePayment(paymentId)],
    ["retrieve_refund", () => getSquareRefund(refundId)],
    ["list_payments", () => listSquarePayments(listWindow())],
    ["list_refunds", () => listSquareRefunds(listWindow())],
  ] as const)(
    "rejects malformed, empty, and invalid %s success responses",
    async (operation, invoke) => {
      for (const scenario of [
        "malformed_json",
        "empty_success",
        "invalid_success",
      ]) {
        await setScenario(operation, scenario);
        await expect(invoke()).rejects.toThrow(/square_/u);
      }
    },
  );

  it("preserves valid empty list results and rejects unsafe receipt URLs", async () => {
    await setScenario("list_payments", "no_results");
    await expect(listSquarePayments(listWindow())).resolves.toEqual([]);
    await setScenario("list_refunds", "no_results");
    await expect(listSquareRefunds(listWindow())).resolves.toEqual([]);

    const unsafeReceiptFetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            payment: {
              id: paymentId,
              receipt_url: "javascript:private-card-suffix-4242",
            },
          }),
          { status: 200 },
        ),
      ),
    ) as typeof fetch;
    await expect(
      getSquarePayment(paymentId, {
        accessToken: "e2e-square-access-token",
        fetchImpl: unsafeReceiptFetch,
        environment: {},
      }),
    ).rejects.toThrow("square_payment_invalid_response");
  });

  it.each([
    ["invalid card suffix", { card_details: { card: { last_4: "ABCD" } } }],
    ["invalid timestamp", { created_at: "not-a-provider-timestamp" }],
    [
      "unsafe integer amount",
      { amount_money: { amount: "999999999999999999999", currency: "USD" } },
    ],
  ])("rejects %s in a successful payment payload", async (_label, fields) => {
    const invalidFetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ payment: { id: paymentId, ...fields } }),
          {
            status: 200,
          },
        ),
      ),
    ) as typeof fetch;
    await expect(
      getSquarePayment(paymentId, {
        accessToken: "e2e-square-access-token",
        fetchImpl: invalidFetch,
        environment: {},
      }),
    ).rejects.toThrow(/square_/u);
  });

  it("exposes only status and a safe failure code for provider errors", async () => {
    await setScenario("retrieve_payment", "forbidden");
    const providerError = await getSquarePayment(paymentId).catch(
      (error: unknown) => error,
    );
    expect(providerError).toBeInstanceOf(SquareApiError);
    expect(providerError).toMatchObject({
      status: 403,
      failureCode: "square_provider_http_403",
    });
    expect(providerError).not.toHaveProperty("details");
    expect(providerError).not.toHaveProperty("body");

    process.env["SQUARE_API_BASE_URL"] = "https://connect.squareup.com";
    await expect(getSquarePayment(paymentId)).rejects.toThrow(
      "SQUARE_API_BASE_URL must target a loopback service during E2E or CRM audit runs",
    );
  });

  it("times out and recovers deterministically after a one-shot failure", async () => {
    await setScenario("retrieve_refund", "timeout", { delayMs: 250 });
    await expect(
      getSquareRefund(refundId, { timeoutMs: 100 }),
    ).rejects.toThrow();

    await setScenario("retrieve_payment", "conflict", { repeat: 1 });
    await expect(getSquarePayment(paymentId)).rejects.toMatchObject({
      status: 409,
    });
    await expect(getSquarePayment(paymentId)).resolves.toMatchObject({
      id: paymentId,
    });
  });

  it("rejects an oversized success without retaining or exposing its body", async () => {
    const privatePayload = "private-square-body-marker".repeat(100_000);
    const oversizedFetch = jest.fn(() =>
      Promise.resolve(
        new Response(privatePayload, {
          status: 200,
          headers: { "content-length": String(privatePayload.length) },
        }),
      ),
    ) as typeof fetch;
    const error = await getSquarePayment(paymentId, {
      accessToken: "e2e-square-access-token",
      fetchImpl: oversizedFetch,
      environment: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("square_response_too_large");
    expect(JSON.stringify(error)).not.toContain("private-square-body-marker");
  });
});
