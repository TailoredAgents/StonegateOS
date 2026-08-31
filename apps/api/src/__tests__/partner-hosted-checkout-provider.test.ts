import {
  createSquarePartnerHostedCheckoutProvider,
  isSafePartnerHostedCheckoutUrl,
  isSecurePartnerPaymentReturnUrl,
} from "@/lib/partner-hosted-checkout-provider";

const REQUEST = {
  intentId: "11111111-1111-4111-8111-111111111111",
  invoiceId: "22222222-2222-4222-8222-222222222222",
  invoiceNumber: "INV-2048",
  amountMinor: 12_500,
  currency: "USD" as const,
  redirectUrl: "https://partners.example.test/partners/billing",
};

function providerResponse(url = "https://sandbox.square.link/u/checkout") {
  return new Response(
    JSON.stringify({
      payment_link: {
        id: "link-1",
        order_id: "order-1",
        url,
        created_at: "2026-08-30T12:00:00.000Z",
      },
    }),
    { status: 200 },
  );
}

describe("provider-neutral partner hosted checkout adapter", () => {
  it("creates a card-only hosted redirect with integer minor units", async () => {
    const calls: Array<{
      request: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const fetchImpl: typeof fetch = (request, init) => {
      calls.push({ request, ...(init ? { init } : {}) });
      return Promise.resolve(providerResponse());
    };
    const provider = createSquarePartnerHostedCheckoutProvider({
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      environment: {
        NODE_ENV: "test",
        SQUARE_ENVIRONMENT: "sandbox",
        SQUARE_API_BASE_URL: "https://square-gateway.example.test/provider",
      },
      fetchImpl,
    });

    await expect(provider.createHostedCheckout(REQUEST)).resolves.toEqual({
      provider: "square",
      providerLinkId: "link-1",
      providerOrderId: "order-1",
      url: "https://sandbox.square.link/u/checkout",
      createdAt: "2026-08-30T12:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected provider request");
    expect(call.request).toBe(
      "https://square-gateway.example.test/provider/v2/online-checkout/payment-links",
    );
    expect(call.init?.method).toBe("POST");
    if (typeof call.init?.body !== "string") {
      throw new Error("expected JSON provider body");
    }
    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      idempotency_key: REQUEST.intentId,
      quick_pay: {
        price_money: { amount: 12_500, currency: "USD" },
        location_id: "LOCATION-1",
      },
      checkout_options: {
        allow_tipping: false,
        ask_for_shipping_address: false,
        redirect_url: REQUEST.redirectUrl,
        accepted_payment_methods: {
          apple_pay: false,
          google_pay: false,
          cash_app_pay: false,
          afterpay_clearpay: false,
        },
      },
    });
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('"source_id"');
    expect(serialized).not.toContain('"card"');
    expect(serialized).not.toContain('"bank_account"');
    expect(serialized).not.toContain("buyer_email");
  });

  it("fails closed on provider errors and unsafe checkout URLs", async () => {
    const providerFailure = createSquarePartnerHostedCheckoutProvider({
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () =>
        Promise.resolve(new Response("unavailable", { status: 503 })),
    });
    await expect(
      providerFailure.createHostedCheckout(REQUEST),
    ).rejects.toMatchObject({
      code: "provider_http_503",
      retryable: true,
      providerStatus: 503,
    });

    const unsafeResponse = createSquarePartnerHostedCheckoutProvider({
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () =>
        Promise.resolve(providerResponse("https://square.link.evil.test/pay")),
    });
    await expect(
      unsafeResponse.createHostedCheckout(REQUEST),
    ).rejects.toMatchObject({
      code: "provider_invalid_response",
    });
  });

  it("rejects invalid configuration, amounts, and oversized responses", async () => {
    expect(() =>
      createSquarePartnerHostedCheckoutProvider({
        accessToken: "token-with-newline\nnot-allowed",
        locationId: "LOCATION-1",
      }),
    ).toThrow("provider_not_configured");

    const invalidRequest = createSquarePartnerHostedCheckoutProvider({
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () => Promise.resolve(providerResponse()),
    });
    await expect(
      invalidRequest.createHostedCheckout({
        ...REQUEST,
        amountMinor: 12.5,
      }),
    ).rejects.toMatchObject({
      code: "provider_request_invalid",
      retryable: false,
    });

    const oversizedResponse = createSquarePartnerHostedCheckoutProvider({
      accessToken: "sandbox-access-token",
      locationId: "LOCATION-1",
      environment: {
        SQUARE_API_BASE_URL: "https://square-gateway.example.test",
      },
      fetchImpl: () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(300 * 1024) },
          }),
        ),
    });
    await expect(
      oversizedResponse.createHostedCheckout(REQUEST),
    ).rejects.toMatchObject({
      code: "provider_response_too_large",
      retryable: true,
    });
  });

  it("requires HTTPS for provider return and returned checkout URLs", () => {
    expect(
      isSecurePartnerPaymentReturnUrl(
        "https://partners.example.test/partners/billing",
      ),
    ).toBe(true);
    expect(
      isSecurePartnerPaymentReturnUrl(
        "http://partners.example.test/partners/billing",
      ),
    ).toBe(false);
    expect(isSafePartnerHostedCheckoutUrl("https://square.link/u/test")).toBe(
      true,
    );
    expect(
      isSafePartnerHostedCheckoutUrl("https://checkout.square.site/test"),
    ).toBe(true);
    expect(
      isSafePartnerHostedCheckoutUrl("https://square.link.evil.test/test"),
    ).toBe(false);
  });
});
