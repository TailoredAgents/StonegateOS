import crypto from "node:crypto";
import {
  buildSquarePosLaunchUrl,
  createSquarePosState,
  extractSquareAttemptIdFromOrder,
  parseSquarePosCallback,
  verifySquarePosState,
  verifySquareWebhookSignature,
} from "@/lib/square-pos";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-24T12:00:00.000Z");
const STATE_SECRET = "test-secret-with-at-least-32-bytes";

describe("Square POS state", () => {
  it("round trips a signed state and rejects tampering and expiry", () => {
    const state = createSquarePosState({
      attemptId: ATTEMPT_ID,
      secret: STATE_SECRET,
      nonce: "abcdefghijklmnop",
      now: NOW,
      ttlSeconds: 60,
    });

    expect(
      verifySquarePosState({
        state,
        secret: STATE_SECRET,
        now: new Date("2026-07-24T12:00:30.000Z"),
      }),
    ).toEqual({
      attemptId: ATTEMPT_ID,
      nonce: "abcdefghijklmnop",
      expiresAt: new Date("2026-07-24T12:01:00.000Z"),
    });
    expect(
      verifySquarePosState({
        state: `${state.slice(0, -1)}x`,
        secret: STATE_SECRET,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      verifySquarePosState({
        state,
        secret: STATE_SECRET,
        now: new Date("2026-07-24T12:01:01.000Z"),
      }),
    ).toBeNull();
  });

  it("rejects a weak state signing secret", () => {
    expect(() =>
      createSquarePosState({
        attemptId: ATTEMPT_ID,
        secret: "too-short",
        nonce: "abcdefghijklmnop",
        now: NOW,
      }),
    ).toThrow("square_state_secret_too_short");
  });
});

describe("Square POS URLs and callbacks", () => {
  const shared = {
    amountCents: 12_345,
    applicationId: "sq0idp-example",
    locationId: "LOCATION",
    callbackUrl: "https://stonegate.example/mobile/payment-return",
    fallbackUrl: "https://stonegate.example/mobile",
    state: "signed.state",
    note: `Stonegate appointment ${APPOINTMENT_ID}; attempt ${ATTEMPT_ID}`,
  };

  it("builds an iOS card-only request with fees cleared and receipts enabled", () => {
    const launchUrl = buildSquarePosLaunchUrl({
      ...shared,
      platform: "ios",
    });
    const parsed = new URL(launchUrl);
    const data = JSON.parse(parsed.searchParams.get("data") ?? "{}") as {
      amount_money: { amount: string };
      state: string;
      options: Record<string, unknown>;
    };

    expect(data.amount_money.amount).toBe("12345");
    expect(data.state).toBe("signed.state");
    expect(data.options).toMatchObject({
      supported_tender_types: ["CREDIT_CARD"],
      clear_default_fees: true,
      auto_return: true,
      skip_receipt: false,
    });
  });

  it("builds an Android card-only intent with exact state metadata", () => {
    const launchUrl = buildSquarePosLaunchUrl({
      ...shared,
      platform: "android",
    });
    expect(launchUrl).toContain(
      "S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD",
    );
    expect(launchUrl).toContain(
      "S.com.squareup.pos.REQUEST_METADATA=signed.state",
    );
    expect(launchUrl).toContain("i.com.squareup.pos.TOTAL_AMOUNT=12345");
  });

  it("normalizes iOS and Android callbacks", () => {
    const ios = new URLSearchParams({
      data: JSON.stringify({
        status: "ok",
        transaction_id: "order-1",
        client_transaction_id: "client-1",
        state: "signed.state",
      }),
    });
    expect(parseSquarePosCallback(ios)).toMatchObject({
      platform: "ios",
      status: "ok",
      transactionId: "order-1",
      state: "signed.state",
    });

    const android = new URLSearchParams({
      "com.squareup.pos.ERROR_CODE": "TRANSACTION_CANCELED",
      "com.squareup.pos.ERROR_DESCRIPTION": "Canceled",
      "com.squareup.pos.REQUEST_METADATA": "signed.state",
    });
    expect(parseSquarePosCallback(android)).toMatchObject({
      platform: "android",
      status: "error",
      errorCode: "TRANSACTION_CANCELED",
      state: "signed.state",
    });
  });
});

describe("Square reconciliation helpers", () => {
  it("extracts only an explicit attempt marker from an order", () => {
    expect(
      extractSquareAttemptIdFromOrder({
        line_items: [
          {
            note: `Stonegate appointment ${APPOINTMENT_ID}; attempt ${ATTEMPT_ID}`,
          },
        ],
      }),
    ).toBe(ATTEMPT_ID);
    expect(extractSquareAttemptIdFromOrder({ note: "similar amount" })).toBeNull();
  });

  it("validates webhook signatures with a constant-time compatible digest", () => {
    const rawBody = '{"event_id":"event-1"}';
    const notificationUrl = "https://api.example.com/api/webhooks/square";
    const signatureKey = "signature-key";
    const signature = crypto
      .createHmac("sha256", signatureKey)
      .update(`${notificationUrl}${rawBody}`)
      .digest("base64");

    expect(
      verifySquareWebhookSignature({
        rawBody,
        signature,
        signatureKey,
        notificationUrl,
      }),
    ).toBe(true);
    expect(
      verifySquareWebhookSignature({
        rawBody: `${rawBody} `,
        signature,
        signatureKey,
        notificationUrl,
      }),
    ).toBe(false);
  });
});
