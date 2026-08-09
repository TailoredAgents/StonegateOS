import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStrictSquareReturnBody,
  squareReturnOperationIdentityMatches,
} from "../../app/api/payments/square/return/route";
import {
  completedSquarePaymentMatchesAttempt,
  squarePaymentBindingMatches,
  squareReturnOperationMatches,
} from "@/lib/square-payments";

const routeSource = readFileSync(
  join(process.cwd(), "app/api/payments/square/return/route.ts"),
  "utf8",
);
const reconciliationSource = readFileSync(
  join(process.cwd(), "src/lib/square-payments.ts"),
  "utf8",
);

const callbackState = "signed-square-state.payload";
const operationIdentity = {
  callbackHash: "a".repeat(64),
  nonceHash: "b".repeat(64),
  bindingHash: "c".repeat(64),
  legacyBinding: false,
  memberId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  authMethod: "team_session" as const,
  providerOrderId: "square-order-1",
};
const storedOperation = {
  version: 1 as const,
  phase: "dispatched" as const,
  operationId: "33333333-3333-4333-8333-333333333333",
  correlationId: "44444444-4444-4444-8444-444444444444",
  ...operationIdentity,
  requestedAt: "2026-08-09T12:00:00.000Z",
};

describe("Square POS return integrity", () => {
  it("accepts one exact iOS callback shape", () => {
    const parsed = parseStrictSquareReturnBody({
      query: {
        data: JSON.stringify({
          status: "ok",
          state: callbackState,
          transaction_id: "square-order-1",
          client_transaction_id: "square-client-1",
        }),
      },
    });

    expect(parsed.callback).toEqual(
      expect.objectContaining({
        platform: "ios",
        status: "ok",
        state: callbackState,
        transactionId: "square-order-1",
      }),
    );
    expect(parsed.callbackHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts one exact Android callback shape", () => {
    const parsed = parseStrictSquareReturnBody({
      query: {
        "com.squareup.pos.REQUEST_METADATA": callbackState,
        "com.squareup.pos.SERVER_TRANSACTION_ID": "square-order-1",
      },
    });
    expect(parsed.callback).toEqual(
      expect.objectContaining({
        platform: "android",
        status: "ok",
        state: callbackState,
        transactionId: "square-order-1",
      }),
    );
  });

  it.each([
    ["unknown body key", { query: { data: "{}" }, extra: true }],
    ["unknown query key", { query: { state: callbackState } }],
    [
      "mixed platform keys",
      {
        query: {
          data: JSON.stringify({
            status: "ok",
            state: callbackState,
            transaction_id: "square-order-1",
          }),
          "com.squareup.pos.REQUEST_METADATA": callbackState,
        },
      },
    ],
    [
      "contradictory iOS status",
      {
        query: {
          data: JSON.stringify({
            status: "ok",
            state: callbackState,
            error_code: "PAYMENT_CANCELED",
          }),
        },
      },
    ],
    [
      "duplicate iOS data key",
      {
        query: {
          data: `{"status":"ok","state":"${callbackState}","state":"other-state","transaction_id":"square-order-1"}`,
        },
      },
    ],
    [
      "Android callback without outcome",
      { query: { "com.squareup.pos.REQUEST_METADATA": callbackState } },
    ],
    [
      "oversized provider value",
      {
        query: {
          "com.squareup.pos.REQUEST_METADATA": callbackState,
          "com.squareup.pos.SERVER_TRANSACTION_ID": "x".repeat(16_385),
        },
      },
    ],
  ])("rejects %s", (_label, body) => {
    expect(() => parseStrictSquareReturnBody(body)).toThrow();
  });

  it("binds a replay to the exact callback, nonce, member, session, auth method, and order", () => {
    expect(
      squareReturnOperationIdentityMatches(storedOperation, operationIdentity),
    ).toBe(true);
    for (const mismatch of [
      { callbackHash: "d".repeat(64) },
      { nonceHash: "e".repeat(64) },
      { memberId: "55555555-5555-4555-8555-555555555555" },
      { sessionId: "66666666-6666-4666-8666-666666666666" },
      { authMethod: "break_glass" as const },
      { providerOrderId: "square-order-2" },
    ]) {
      expect(
        squareReturnOperationIdentityMatches(storedOperation, {
          ...operationIdentity,
          ...mismatch,
        }),
      ).toBe(false);
    }
  });

  it("allows reconciliation finalization only for the exact dispatched operation", () => {
    const metadata = { squareReturnOperation: storedOperation };
    const expected = {
      operationId: storedOperation.operationId,
      callbackHash: storedOperation.callbackHash,
      providerOrderId: storedOperation.providerOrderId,
    };
    expect(squareReturnOperationMatches(metadata, expected)).toBe(true);
    expect(
      squareReturnOperationMatches(
        {
          squareReturnOperation: { ...storedOperation, phase: "requested" },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      squareReturnOperationMatches(metadata, {
        ...expected,
        providerOrderId: "square-order-2",
      }),
    ).toBe(false);
  });

  it("rejects an existing payment unless every financial relationship is exact", () => {
    const payment = {
      provider: "square",
      appointmentId: "77777777-7777-4777-8777-777777777777",
      paymentAttemptId: "88888888-8888-4888-8888-888888888888",
      providerOrderId: "square-order-1",
      providerPaymentId: "square-payment-1",
      jobAmountCents: 10_000,
      tipCents: 2_000,
      totalAmountCents: 12_000,
      amount: 12_000,
      currency: "USD",
      canonicalStatus: "completed",
    };
    const verified = {
      providerOrderId: "square-order-1",
      providerPaymentId: "square-payment-1",
      jobAmountCents: 10_000,
      tipCents: 2_000,
      totalAmountCents: 12_000,
      currency: "USD",
    };
    expect(
      squarePaymentBindingMatches({
        payment,
        appointmentId: payment.appointmentId,
        attemptId: payment.paymentAttemptId,
        verified,
      }),
    ).toBe(true);
    expect(
      squarePaymentBindingMatches({
        payment: { ...payment, appointmentId: null },
        appointmentId: payment.appointmentId,
        attemptId: payment.paymentAttemptId,
        verified,
      }),
    ).toBe(false);
    expect(
      squarePaymentBindingMatches({
        payment: { ...payment, totalAmountCents: 12_001 },
        appointmentId: payment.appointmentId,
        attemptId: payment.paymentAttemptId,
        verified,
      }),
    ).toBe(false);
    expect(
      completedSquarePaymentMatchesAttempt({
        payment,
        attempt: {
          id: payment.paymentAttemptId,
          appointmentId: payment.appointmentId,
          requestedJobAmountCents: 10_000,
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
        },
        orderId: payment.providerOrderId,
      }),
    ).toBe(true);
    expect(
      completedSquarePaymentMatchesAttempt({
        payment: { ...payment, canonicalStatus: "needs_review" },
        attempt: {
          id: payment.paymentAttemptId,
          appointmentId: payment.appointmentId,
          requestedJobAmountCents: 10_000,
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
        },
        orderId: payment.providerOrderId,
      }),
    ).toBe(false);
  });

  it("establishes authorization and the financial kill switch before callback/config/database work", () => {
    const post = routeSource.indexOf("export async function POST");
    const boundary = routeSource.indexOf(
      "await beginTeamMutation(request",
      post,
    );
    expect(boundary).toBeGreaterThan(-1);
    for (const laterBoundary of [
      "request.nextUrl.search",
      "readBoundedJsonRequest(request",
      "squareStateSecret()",
      "database = getDb()",
    ]) {
      expect(routeSource.indexOf(laterBoundary, post)).toBeGreaterThan(
        boundary,
      );
    }
    expect(routeSource).toContain('principalTypes: ["human"]');
    expect(routeSource).toContain('requiredPermissions: ["payments.collect"]');
    expect(routeSource).toContain('risk: "financial"');
    expect(routeSource).not.toContain("isAdminRequest");
  });

  it("persists a one-use nonce and all durable external-effect phases", () => {
    expect(routeSource).toContain("returnNonceHash: null");
    for (const phase of [
      '"requested"',
      '"dispatched"',
      '"succeeded"',
      '"failed"',
      '"reconciliation_required"',
    ]) {
      expect(routeSource).toContain(phase);
    }
    expect(routeSource).toContain('outcome: "attempted"');
    expect(routeSource).toContain("completeTeamMutationIdempotency(");
  });

  it("keeps provider I/O outside transactions and never performs a financial takeover upsert", () => {
    const start = reconciliationSource.indexOf(
      "export async function reconcileSquareAttempt",
    );
    const end = reconciliationSource.indexOf(
      "async function upsertSquarePaymentForReview",
      start,
    );
    const reconciliation = reconciliationSource.slice(start, end);
    expect(
      reconciliation.indexOf("retrieveAndVerifySquarePayment({"),
    ).toBeLessThan(
      reconciliation.indexOf("const result = await db.transaction"),
    );
    expect(reconciliation).toContain(".onConflictDoNothing()");
    expect(reconciliation).not.toContain(".onConflictDoUpdate(");
    expect(reconciliation).toContain('.for("update")');
  });
});
