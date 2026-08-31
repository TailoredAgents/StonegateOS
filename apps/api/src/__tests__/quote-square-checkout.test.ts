import { jest } from "@jest/globals";
import {
  createQuoteCheckoutReturnState,
  createQuoteDepositPaymentLink,
  retrieveQuoteDepositCheckoutOutcome,
  verifyQuoteCheckoutReturnState,
  verifyQuoteDepositBrowserReturn,
} from "@/lib/quote-square-checkout";

const PROVIDER_ENVIRONMENT = {
  NODE_ENV: "test",
  SQUARE_API_BASE_URL: "https://square-gateway.example.test/provider",
};
const ACCESS_TOKEN = "square-access-token-for-tests";
const STATE_SECRET = "state-secret-with-more-than-thirty-two-bytes";
const NOW = new Date("2026-08-30T12:00:00.000Z");

function paymentLinkResponse(): Response {
  return new Response(
    JSON.stringify({
      payment_link: {
        id: "payment-link-1",
        version: 1,
        order_id: "stored-order-1",
        url: "https://sandbox.square.link/u/deposit-checkout",
        long_url: "https://checkout.square.site/deposit-checkout",
        created_at: "2026-08-30T12:00:01.000Z",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function providerFetch(input?: {
  orderState?: string;
  orderId?: string;
  paymentIds?: string[];
  paymentStatus?: string;
  paymentAmount?: number;
  tipAmount?: number;
  refundedAmount?: number;
  locationId?: string;
  paymentOrderId?: string;
  paymentCreatedAt?: string;
}): typeof fetch {
  const orderId = input?.orderId ?? "stored-order-1";
  const paymentIds = input?.paymentIds ?? ["payment-1"];
  const amount = input?.paymentAmount ?? 12_500;
  const tip = input?.tipAmount ?? 0;
  const locationId = input?.locationId ?? "LOCATION-1";
  return jest.fn((request: string | URL | Request) => {
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    if (url.endsWith(`/v2/orders/${orderId}`)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            order: {
              id: orderId,
              location_id: locationId,
              state: input?.orderState ?? "COMPLETED",
              total_money: { amount: 12_500, currency: "USD" },
              total_tip_money: { amount: tip, currency: "USD" },
              tenders: paymentIds.map((paymentId) => ({
                id: paymentId,
                payment_id: paymentId,
                type: "CARD",
                location_id: locationId,
                amount_money: { amount: 12_500, currency: "USD" },
                tip_money: { amount: tip, currency: "USD" },
              })),
            },
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith(`/v2/payments/${paymentIds[0] ?? "payment-1"}`)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            payment: {
              id: paymentIds[0] ?? "payment-1",
              order_id: input?.paymentOrderId ?? orderId,
              location_id: locationId,
              status: input?.paymentStatus ?? "COMPLETED",
              source_type: "CARD",
              amount_money: { amount, currency: "USD" },
              tip_money: { amount: tip, currency: "USD" },
              total_money: { amount: amount + tip, currency: "USD" },
              refunded_money: {
                amount: input?.refundedAmount ?? 0,
                currency: "USD",
              },
              receipt_url: "https://square.example.test/receipt",
              created_at: input?.paymentCreatedAt ?? "2026-08-30T12:05:00.000Z",
              updated_at: "2026-08-30T12:05:01.000Z",
            },
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

describe("Quote Square hosted Checkout", () => {
  it("creates an idempotent exact-USD Quick Pay link without persisted buyer data or capabilities", async () => {
    const fetchImpl = jest.fn(
      (_request: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
          `Bearer ${ACCESS_TOKEN}`,
        );
        return Promise.resolve(paymentLinkResponse());
      },
    ) as typeof fetch;

    const created = await createQuoteDepositPaymentLink({
      amountCents: 12_500,
      locationId: "LOCATION-1",
      idempotencyKey: "attempt-11111111-1111-4111-8111-111111111111",
      displayName: "Quote Q-2048 deposit",
      buyer: {
        email: "Buyer@Example.com",
        phoneNumber: "+14155550123",
      },
      returnUrl: "https://crm.example.com/quote/deposit/return?flow=quote",
      returnStateSecret: STATE_SECRET,
      accessToken: ACCESS_TOKEN,
      environment: PROVIDER_ENVIRONMENT,
      fetchImpl,
      now: NOW,
      randomBytesImpl: () => new Uint8Array(32).fill(7),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [request, init] = (fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(request).toBe(
      "https://square-gateway.example.test/provider/v2/online-checkout/payment-links",
    );
    expect(typeof init.body).toBe("string");
    const body = JSON.parse(
      typeof init.body === "string" ? init.body : "null",
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      idempotency_key: "attempt-11111111-1111-4111-8111-111111111111",
      quick_pay: {
        name: "Quote Q-2048 deposit",
        price_money: { amount: 12_500, currency: "USD" },
        location_id: "LOCATION-1",
      },
      checkout_options: {
        allow_tipping: false,
        ask_for_shipping_address: false,
        enable_coupon: false,
        enable_loyalty: false,
      },
      pre_populated_data: {
        buyer_email: "buyer@example.com",
        buyer_phone_number: "+14155550123",
      },
    });
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("reference_id");
    expect(body).not.toHaveProperty("payment_note");
    expect(JSON.stringify(body)).not.toMatch(/capability|shareToken/iu);

    const redirectUrl = new URL(
      (body["checkout_options"] as { redirect_url: string }).redirect_url,
    );
    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(
      verifyQuoteCheckoutReturnState({
        state: state!,
        secret: STATE_SECRET,
        expectedHash: created.requestFacts.returnStateHash,
        now: NOW,
      }),
    ).toMatchObject({ valid: true });

    expect(created).toMatchObject({
      checkoutUrl: "https://sandbox.square.link/u/deposit-checkout",
      providerPaymentLinkId: "payment-link-1",
      providerOrderId: "stored-order-1",
      providerVersion: 1,
      requestFacts: {
        purpose: "quote_deposit",
        expectedAmountCents: 12_500,
        currency: "USD",
        tippingAllowed: false,
        couponsEnabled: false,
        loyaltyEnabled: false,
        buyerEmailPrefilled: true,
        buyerPhonePrefilled: true,
      },
    });
    const persistedFacts = JSON.stringify(created);
    expect(persistedFacts).not.toContain("buyer@example.com");
    expect(persistedFacts).not.toContain("+14155550123");
    expect(persistedFacts).not.toContain(STATE_SECRET);
    expect(persistedFacts).not.toContain(
      "attempt-11111111-1111-4111-8111-111111111111",
    );
  });

  it("uses an identity-free signed state and rejects tampering, substitution, and expiry", () => {
    const state = createQuoteCheckoutReturnState({
      secret: STATE_SECRET,
      now: NOW,
      ttlSeconds: 300,
      randomBytesImpl: () => new Uint8Array(32).fill(9),
    });
    expect(state.value).not.toMatch(/quote|response|customer|capability/iu);
    expect(
      verifyQuoteCheckoutReturnState({
        state: state.value,
        secret: STATE_SECRET,
        expectedHash: state.hash,
        now: new Date("2026-08-30T12:04:59.000Z"),
      }),
    ).toMatchObject({ valid: true });

    const tampered = `${state.value.slice(0, -1)}A`;
    expect(
      verifyQuoteCheckoutReturnState({
        state: tampered,
        secret: STATE_SECRET,
        expectedHash: state.hash,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: "state_mismatch" });
    expect(
      verifyQuoteCheckoutReturnState({
        state: state.value,
        secret: STATE_SECRET,
        expectedHash: "a".repeat(64),
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: "state_mismatch" });
    expect(
      verifyQuoteCheckoutReturnState({
        state: state.value,
        secret: STATE_SECRET,
        expectedHash: state.hash,
        now: new Date("2026-08-30T12:05:01.000Z"),
      }),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("verifies a captured deposit from the stored order and retrieved payment", async () => {
    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        providerOrderId: "stored-order-1",
        expectedAmountCents: 12_500,
        expectedLocationId: "LOCATION-1",
        accessToken: ACCESS_TOKEN,
        environment: PROVIDER_ENVIRONMENT,
        fetchImpl: providerFetch(),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: "captured",
      reason: "verified_capture",
      providerOrderId: "stored-order-1",
      providerPaymentId: "payment-1",
      providerPaymentStatus: "COMPLETED",
      capturedAmountCents: 12_500,
      refundedAmountCents: 0,
      requiresSchedulingConfirmation: false,
      requiresRefundReview: false,
    });
  });

  it("ignores forged browser order and transaction IDs and retrieves the stored order", async () => {
    const state = createQuoteCheckoutReturnState({
      secret: STATE_SECRET,
      now: NOW,
      randomBytesImpl: () => new Uint8Array(32).fill(5),
    });
    const fetchImpl = providerFetch();
    const result = await verifyQuoteDepositBrowserReturn({
      browserReturnUrl: `https://crm.example.com/quote/deposit/return?state=${encodeURIComponent(state.value)}&orderId=forged-order&transactionId=forged-payment`,
      returnStateSecret: STATE_SECRET,
      expectedReturnStateHash: state.hash,
      providerOrderId: "stored-order-1",
      expectedAmountCents: 12_500,
      expectedLocationId: "LOCATION-1",
      accessToken: ACCESS_TOKEN,
      environment: PROVIDER_ENVIRONMENT,
      fetchImpl,
      now: NOW,
    });

    expect(result.status).toBe("captured");
    const providerCalls = (fetchImpl as jest.MockedFunction<typeof fetch>).mock
      .calls;
    const requestedUrls = providerCalls.map(([request]) =>
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url,
    );
    expect(requestedUrls).toEqual([
      "https://square-gateway.example.test/provider/v2/orders/stored-order-1",
      "https://square-gateway.example.test/provider/v2/payments/payment-1",
    ]);
    expect(requestedUrls.join(" ")).not.toContain("forged");
  });

  it.each([
    ["APPROVED", "pending", "payment_pending"],
    ["PENDING", "pending", "payment_pending"],
    ["FAILED", "declined", "payment_failed"],
    ["CANCELED", "declined", "payment_canceled"],
  ])(
    "classifies %s provider payments as %s",
    async (paymentStatus, expectedStatus, expectedReason) => {
      await expect(
        retrieveQuoteDepositCheckoutOutcome({
          providerOrderId: "stored-order-1",
          expectedAmountCents: 12_500,
          expectedLocationId: "LOCATION-1",
          accessToken: ACCESS_TOKEN,
          environment: PROVIDER_ENVIRONMENT,
          fetchImpl: providerFetch({
            orderState: "OPEN",
            paymentStatus,
          }),
          now: NOW,
        }),
      ).resolves.toMatchObject({
        status: expectedStatus,
        reason: expectedReason,
      });
    },
  );

  it("distinguishes no payment from a canceled order", async () => {
    const shared = {
      providerOrderId: "stored-order-1",
      expectedAmountCents: 12_500,
      expectedLocationId: "LOCATION-1",
      accessToken: ACCESS_TOKEN,
      environment: PROVIDER_ENVIRONMENT,
      now: NOW,
    } as const;
    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        ...shared,
        fetchImpl: providerFetch({ orderState: "OPEN", paymentIds: [] }),
      }),
    ).resolves.toMatchObject({
      status: "pending",
      reason: "payment_not_created",
    });
    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        ...shared,
        fetchImpl: providerFetch({ orderState: "CANCELED", paymentIds: [] }),
      }),
    ).resolves.toMatchObject({
      status: "declined",
      reason: "order_canceled",
    });
  });

  it("marks a capture after the slot hold as late and requiring rebook/refund review", async () => {
    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        providerOrderId: "stored-order-1",
        expectedAmountCents: 12_500,
        expectedLocationId: "LOCATION-1",
        holdExpiresAt: new Date("2026-08-30T12:04:59.000Z"),
        accessToken: ACCESS_TOKEN,
        environment: PROVIDER_ENVIRONMENT,
        fetchImpl: providerFetch({
          paymentCreatedAt: "2026-08-30T12:05:00.000Z",
        }),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: "late_capture",
      reason: "hold_expired_before_capture",
      requiresSchedulingConfirmation: true,
      requiresRefundReview: true,
    });
  });

  it("returns a bounded refund-review outcome for refunds and reconciliation mismatches", async () => {
    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        providerOrderId: "stored-order-1",
        expectedAmountCents: 12_500,
        expectedLocationId: "LOCATION-1",
        accessToken: ACCESS_TOKEN,
        environment: PROVIDER_ENVIRONMENT,
        fetchImpl: providerFetch({ refundedAmount: 2_500 }),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: "refund_review",
      reason: "refund_detected",
      capturedAmountCents: 12_500,
      refundedAmountCents: 2_500,
      requiresRefundReview: true,
    });

    await expect(
      retrieveQuoteDepositCheckoutOutcome({
        providerOrderId: "stored-order-1",
        expectedAmountCents: 12_500,
        expectedLocationId: "LOCATION-1",
        accessToken: ACCESS_TOKEN,
        environment: PROVIDER_ENVIRONMENT,
        fetchImpl: providerFetch({ paymentAmount: 12_499 }),
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: "refund_review",
      reason: "amount_mismatch",
    });
  });
});
