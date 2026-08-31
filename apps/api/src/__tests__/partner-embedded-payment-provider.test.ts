import {
  createSquarePartnerEmbeddedPaymentProvider,
  PartnerEmbeddedPaymentProviderError,
} from "@/lib/partner-embedded-payment-provider";

const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("provider-neutral partner embedded card adapter", () => {
  it("creates an exact order then completes it with a one-use card token", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (request, init) => {
      if (typeof init?.body !== "string") throw new Error("expected body");
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/v2/orders")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              order: {
                id: "ORDER-1",
                location_id: "LOCATION-1",
                state: "OPEN",
                total_money: { amount: 7_500, currency: "USD" },
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            payment: {
              id: "PAYMENT-1",
              order_id: "ORDER-1",
              location_id: "LOCATION-1",
              status: "COMPLETED",
              source_type: "CARD",
              amount_money: { amount: 7_500, currency: "USD" },
            },
          }),
          { status: 200 },
        ),
      );
    };
    const provider = createSquarePartnerEmbeddedPaymentProvider({
      applicationId: "sandbox-sq0idb-example",
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      fetchImpl,
      environment: {
        NODE_ENV: "test",
        SQUARE_ENVIRONMENT: "sandbox",
        SQUARE_API_BASE_URL: "https://square-gateway.example.test/provider",
      },
    });

    expect(provider.webPayments).toEqual({
      applicationId: "sandbox-sq0idb-example",
      locationId: "LOCATION-1",
      environment: "sandbox",
      sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
      methods: { card: true, ach: false },
      achUnavailableReason: "merchant_and_return_configuration_required",
    });
    await expect(
      provider.createOrder({
        intentId: INTENT_ID,
        appointmentId: APPOINTMENT_ID,
        invoiceNumber: "INV-2048",
        purpose: "deposit",
        amountMinor: 7_500,
        currency: "USD",
      }),
    ).resolves.toEqual({
      provider: "square",
      providerOrderId: "ORDER-1",
      locationId: "LOCATION-1",
    });
    const sourceToken = "cnon:single-use-browser-token";
    await expect(
      provider.createPayment({
        intentId: INTENT_ID,
        appointmentId: APPOINTMENT_ID,
        providerOrderId: "ORDER-1",
        sourceToken,
        amountMinor: 7_500,
        currency: "USD",
      }),
    ).resolves.toEqual({
      provider: "square",
      providerOrderId: "ORDER-1",
      providerPaymentId: "PAYMENT-1",
      locationId: "LOCATION-1",
      providerStatus: "COMPLETED",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://square-gateway.example.test/provider/v2/orders",
    );
    expect(calls[0]?.body).toMatchObject({
      idempotency_key: `${INTENT_ID}-order`,
      order: {
        location_id: "LOCATION-1",
        reference_id: INTENT_ID,
        line_items: [
          {
            quantity: "1",
            base_price_money: { amount: 7_500, currency: "USD" },
          },
        ],
      },
    });
    expect(calls[1]?.url).toBe(
      "https://square-gateway.example.test/provider/v2/payments",
    );
    expect(calls[1]?.body).toMatchObject({
      source_id: sourceToken,
      idempotency_key: INTENT_ID,
      amount_money: { amount: 7_500, currency: "USD" },
      autocomplete: true,
      order_id: "ORDER-1",
      location_id: "LOCATION-1",
      reference_id: INTENT_ID,
    });
    expect(JSON.stringify(provider.webPayments)).not.toContain(sourceToken);
  });

  it("fails closed on missing application configuration and response mismatch", async () => {
    expect(() =>
      createSquarePartnerEmbeddedPaymentProvider({
        accessToken: "token",
        locationId: "LOCATION-1",
        environment: {},
      }),
    ).toThrow(PartnerEmbeddedPaymentProviderError);

    const provider = createSquarePartnerEmbeddedPaymentProvider({
      applicationId: "sq0idp-example",
      accessToken: "token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              order: {
                id: "ORDER-1",
                location_id: "OTHER-LOCATION",
                state: "OPEN",
                total_money: { amount: 7_500, currency: "USD" },
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      provider.createOrder({
        intentId: INTENT_ID,
        appointmentId: APPOINTMENT_ID,
        invoiceNumber: "INV-2048",
        purpose: "deposit",
        amountMinor: 7_500,
        currency: "USD",
      }),
    ).rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("marks transport ambiguity as indeterminate without exposing provider bodies", async () => {
    const provider = createSquarePartnerEmbeddedPaymentProvider({
      applicationId: "sq0idp-example",
      accessToken: "token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () => Promise.reject(new TypeError("network down")),
    });
    await expect(
      provider.createPayment({
        intentId: INTENT_ID,
        appointmentId: APPOINTMENT_ID,
        providerOrderId: "ORDER-1",
        sourceToken: "cnon:single-use-browser-token",
        amountMinor: 7_500,
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "provider_payment_request_indeterminate",
      retryable: true,
      indeterminate: true,
    });
  });
});
