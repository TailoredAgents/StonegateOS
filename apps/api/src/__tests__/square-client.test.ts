import {
  listSquarePayments,
  listSquareRefunds,
  retrieveAndVerifySquarePayment,
} from "@/lib/square-client";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

type FetchCall = Parameters<typeof fetch>;

interface RecordedFetch {
  (...call: FetchCall): ReturnType<typeof fetch>;
  readonly calls: FetchCall[];
}

function recordedFetch(
  implementation: (...call: FetchCall) => ReturnType<typeof fetch>,
): RecordedFetch {
  const calls: FetchCall[] = [];
  return Object.assign(
    (...call: FetchCall) => {
      calls.push(call);
      return implementation(...call);
    },
    { calls },
  );
}

function squareFetch(input?: {
  amount?: number;
  tip?: number;
  total?: number;
  locationId?: string;
  paymentStatus?: string;
  attemptId?: string | null;
  sourceType?: "CARD" | "BANK_ACCOUNT";
}): RecordedFetch {
  const amount = input?.amount ?? 10_000;
  const tip = input?.tip ?? 2_000;
  const total = input?.total ?? amount + tip;
  const locationId = input?.locationId ?? "LOCATION";
  const sourceType = input?.sourceType ?? "CARD";

  return recordedFetch((request) => {
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    if (url.endsWith("/v2/orders/order-1")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            order: {
              id: "order-1",
              location_id: locationId,
              state: "COMPLETED",
              total_money: { amount, currency: "USD" },
              total_tip_money: { amount: tip, currency: "USD" },
              line_items:
                input?.attemptId === null
                  ? []
                  : [
                      {
                        name: "Stonegate job",
                        note: `Stonegate appointment appointment-1; attempt ${input?.attemptId ?? ATTEMPT_ID}`,
                      },
                    ],
              tenders: [
                {
                  id: "payment-1",
                  payment_id: "payment-1",
                  type: sourceType,
                  location_id: locationId,
                  amount_money: { amount: total, currency: "USD" },
                  tip_money: { amount: tip, currency: "USD" },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/v2/payments/payment-1")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            payment: {
              id: "payment-1",
              order_id: "order-1",
              location_id: locationId,
              status: input?.paymentStatus ?? "COMPLETED",
              source_type: sourceType,
              amount_money: { amount, currency: "USD" },
              tip_money: { amount: tip, currency: "USD" },
              total_money: { amount: total, currency: "USD" },
              refunded_money: { amount: 0, currency: "USD" },
              receipt_url: "https://square.example/receipt",
              card_details: {
                entry_method: "CONTACTLESS",
                card: { card_brand: "VISA", last_4: "4242" },
              },
            },
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

describe("Square payment verification", () => {
  it("verifies order, location, job amount, tip, and card details", async () => {
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch(),
      }),
    ).resolves.toMatchObject({
      providerPaymentId: "payment-1",
      providerOrderId: "order-1",
      jobAmountCents: 10_000,
      tipCents: 2_000,
      totalAmountCents: 12_000,
      currency: "USD",
      entryMethod: "CONTACTLESS",
      cardBrand: "VISA",
      last4: "4242",
    });
  });

  it("verifies a completed bank-account tender only when ACH is expected", async () => {
    const fetchImpl = squareFetch({
      amount: 10_000,
      tip: 0,
      total: 10_000,
      sourceType: "BANK_ACCOUNT",
    });
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        expectedSourceType: "BANK_ACCOUNT",
        accessToken: "token",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      tenderType: "bank_account",
      entryMethod: null,
      cardBrand: null,
      last4: null,
      totalAmountCents: 10_000,
    });
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch({
          amount: 10_000,
          tip: 0,
          total: 10_000,
          sourceType: "BANK_ACCOUNT",
        }),
      }),
    ).rejects.toThrow("square_card_tender_count_mismatch");
  });

  it("rejects a mismatched job amount", async () => {
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 9_999,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch(),
      }),
    ).rejects.toThrow("square_payment_amount_mismatch");
  });

  it("rejects the wrong seller location", async () => {
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "EXPECTED",
        accessToken: "token",
        fetchImpl: squareFetch({ locationId: "WRONG" }),
      }),
    ).rejects.toThrow("square_location_mismatch");
  });

  it("rejects inconsistent Square totals", async () => {
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch({ total: 11_999 }),
      }),
    ).rejects.toThrow("square_payment_total_mismatch");
  });

  it("rejects inconsistent order or tender totals", async () => {
    const fetchImpl = squareFetch();
    const inconsistentFetch = recordedFetch(
      async (request: string | URL | Request, init?: RequestInit) => {
        const response = await fetchImpl(request, init);
        const url =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.toString()
              : request.url;
        if (!url.endsWith("/v2/orders/order-1")) return response;
        const body = (await response.json()) as {
          order: { total_money: { amount: number } };
        };
        body.order.total_money.amount -= 1;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    );

    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: inconsistentFetch,
      }),
    ).rejects.toThrow("square_order_tender_amount_mismatch");
  });

  it("rejects a Square order that is not bound to the local attempt", async () => {
    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch({
          attemptId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    ).rejects.toThrow("square_attempt_reference_mismatch");

    await expect(
      retrieveAndVerifySquarePayment({
        orderId: "order-1",
        expectedAttemptId: ATTEMPT_ID,
        expectedJobAmountCents: 10_000,
        expectedLocationId: "LOCATION",
        accessToken: "token",
        fetchImpl: squareFetch({ attemptId: null }),
      }),
    ).rejects.toThrow("square_attempt_reference_mismatch");
  });
});

describe("Square list pagination", () => {
  it("walks every payment and refund cursor in the bounded window", async () => {
    const fetchImpl = recordedFetch((request) => {
      const url = new URL(
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url,
      );
      const cursor = url.searchParams.get("cursor");
      if (url.pathname === "/v2/payments") {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              cursor
                ? { payments: [{ id: "payment-2" }] }
                : {
                    payments: [{ id: "payment-1" }],
                    cursor: "payments-next",
                  },
            ),
            { status: 200 },
          ),
        );
      }
      if (url.pathname === "/v2/refunds") {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              cursor
                ? { refunds: [{ id: "refund-2" }] }
                : {
                    refunds: [{ id: "refund-1" }],
                    cursor: "refunds-next",
                  },
            ),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const window = {
      locationId: "LOCATION",
      beginTime: new Date("2026-07-23T00:00:00.000Z"),
      endTime: new Date("2026-07-24T00:00:00.000Z"),
      accessToken: "token",
      fetchImpl,
    };

    await expect(listSquarePayments(window)).resolves.toEqual([
      { id: "payment-1" },
      { id: "payment-2" },
    ]);
    await expect(listSquareRefunds(window)).resolves.toEqual([
      { id: "refund-1" },
      { id: "refund-2" },
    ]);
    expect(fetchImpl.calls).toHaveLength(4);
  });

  it("rejects a repeated provider cursor instead of looping", async () => {
    const fetchImpl = recordedFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            payments: [{ id: "payment-1" }],
            cursor: "same-cursor",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      listSquarePayments({
        locationId: "LOCATION",
        beginTime: new Date("2026-07-23T00:00:00.000Z"),
        endTime: new Date("2026-07-24T00:00:00.000Z"),
        accessToken: "token",
        fetchImpl,
      }),
    ).rejects.toThrow("square_pagination_cursor_repeated");
  });
});
