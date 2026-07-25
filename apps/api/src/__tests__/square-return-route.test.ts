import type { NextRequest } from "next/server";

const mockAttempt = {
  id: "attempt-1",
  appointmentId: "appointment-1",
  status: "launched",
  returnNonceHash: "stored-nonce-hash",
  returnStateExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  metadata: {},
};
const mockUpdateValues = jest.fn();
const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockReconcileSquareAttempt = jest.fn();
let mockCallback = {
  state: "signed-state",
  status: "error" as const,
  platform: "ios" as const,
  transactionId: null as string | null,
  clientTransactionId: "client-attempt-1",
  errorCode: "PAYMENT_CANCELED" as string | null,
  errorDescription: "The customer canceled.",
};

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  eq: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  paymentAttempts: {
    id: "payment_attempts.id",
    provider: "payment_attempts.provider",
  },
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockAttempt]),
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => {
        mockUpdateValues(values);
        return { where: mockUpdateWhere };
      },
    }),
  }),
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({
    memberId: "owner-1",
    role: "owner",
  }),
  recordAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/payment-ledger", () => ({
  getAppointmentPaymentSummary: jest.fn(),
}));

jest.mock("@/lib/square-pos", () => ({
  isRetryableSquarePosError: (errorCode: string | null | undefined) =>
    [
      "payment_canceled",
      "transaction_canceled",
      "illegal_location_id",
      "not_logged_in",
    ].includes(errorCode?.trim().toLowerCase() ?? ""),
  parseSquarePosCallback: () => mockCallback,
  verifySquarePosState: () => ({
    attemptId: "attempt-1",
    nonce: "nonce-1",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  }),
}));

jest.mock("@/lib/square-payments", () => ({
  hashSquareReturnNonce: () => "stored-nonce-hash",
  reconcileSquareAttempt: mockReconcileSquareAttempt,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { POST } from "../../app/api/payments/square/return/route";

describe("Square POS return endpoint", () => {
  const originalSecret = process.env["SQUARE_POS_STATE_SECRET"];

  beforeEach(() => {
    process.env["SQUARE_POS_STATE_SECRET"] = "test-state-secret";
    mockCallback = {
      state: "signed-state",
      status: "error",
      platform: "ios",
      transactionId: null,
      clientTransactionId: "client-attempt-1",
      errorCode: "PAYMENT_CANCELED",
      errorDescription: "The customer canceled.",
    };
    mockUpdateValues.mockClear();
    mockUpdateWhere.mockClear();
    mockReconcileSquareAttempt.mockReset();
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env["SQUARE_POS_STATE_SECRET"];
    } else {
      process.env["SQUARE_POS_STATE_SECRET"] = originalSecret;
    }
  });

  it("makes a provider-declared cancellation with no transaction retryable without marking it paid", async () => {
    const request = {
      json: () =>
        Promise.resolve({
          state: "signed-state",
          status: "error",
        }),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      status: string;
      attemptId: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: "canceled",
        attemptId: "attempt-1",
        retryable: true,
      }),
    );
    expect(mockUpdateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "retryable",
        errorCode: "PAYMENT_CANCELED",
      }),
    );
    const recordedCalls = mockUpdateValues.mock.calls as unknown[][];
    const recordedUpdate = recordedCalls[0]?.[0];
    expect(
      (recordedUpdate as Record<string, unknown>)["resolvedAt"],
    ).toBeInstanceOf(Date);
  });

  it("keeps an unknown error without a transaction provisional for reconciliation", async () => {
    mockCallback = {
      ...mockCallback,
      errorCode: "UNEXPECTED",
      errorDescription: "Unknown Square failure.",
    };
    const request = {
      json: () => Promise.resolve({ state: "signed-state" }),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      status: string;
      attemptId: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: "pending_verification",
        attemptId: "attempt-1",
      }),
    );
    expect(mockUpdateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending_verification",
        errorCode: "UNEXPECTED",
      }),
    );
  });

  it("keeps a setup error with a transaction provisional instead of making it retryable", async () => {
    mockCallback = {
      ...mockCallback,
      transactionId: "square-order-1",
      errorCode: "ILLEGAL_LOCATION_ID",
      errorDescription: "Square returned an order with a setup error.",
    };
    mockReconcileSquareAttempt.mockResolvedValue({
      status: "pending_verification",
      errorCode: "square_payment_pending",
    });
    const request = {
      json: () => Promise.resolve({ state: "signed-state" }),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = (await response.json()) as {
      status: string;
      attemptId: string;
      retryable?: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: "pending_verification",
        attemptId: "attempt-1",
      }),
    );
    expect(payload.retryable).not.toBe(true);
    expect(mockUpdateValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "pending_verification",
        providerOrderId: "square-order-1",
        errorCode: "ILLEGAL_LOCATION_ID",
      }),
    );
    expect(mockReconcileSquareAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      orderId: "square-order-1",
    });
  });
});
