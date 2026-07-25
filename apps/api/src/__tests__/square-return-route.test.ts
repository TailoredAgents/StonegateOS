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
  parseSquarePosCallback: () => ({
    state: "signed-state",
    status: "error",
    platform: "ios",
    transactionId: null,
    clientTransactionId: "client-attempt-1",
    errorCode: "PAYMENT_CANCELED",
    errorDescription: "The customer canceled.",
  }),
  verifySquarePosState: () => ({
    attemptId: "attempt-1",
    nonce: "nonce-1",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  }),
}));

jest.mock("@/lib/square-payments", () => ({
  hashSquareReturnNonce: () => "stored-nonce-hash",
  reconcileSquareAttempt: jest.fn(),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { POST } from "../../app/api/payments/square/return/route";

describe("Square POS return endpoint", () => {
  const originalSecret = process.env["SQUARE_POS_STATE_SECRET"];

  beforeEach(() => {
    process.env["SQUARE_POS_STATE_SECRET"] = "test-state-secret";
    mockUpdateValues.mockClear();
    mockUpdateWhere.mockClear();
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env["SQUARE_POS_STATE_SECRET"];
    } else {
      process.env["SQUARE_POS_STATE_SECRET"] = originalSecret;
    }
  });

  it("keeps a canceled or errored callback provisional until provider verification", async () => {
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
        status: "pending_verification",
        attemptId: "attempt-1",
      }),
    );
    expect(mockUpdateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending_verification",
        resolvedAt: null,
        errorCode: "PAYMENT_CANCELED",
      }),
    );
  });
});
