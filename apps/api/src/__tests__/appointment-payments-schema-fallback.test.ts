import type { NextRequest } from "next/server";

const appointmentId = "11111111-1111-4111-8111-111111111111";

let mockFinalTotalCents: number | null = 47_500;
const mockListAppointmentPaymentRows = jest.fn();
const mockGetAppointmentPaymentSummary = jest.fn();

const mockDb = {
  select: jest.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () =>
          Promise.resolve([
            {
              id: appointmentId,
              finalTotalCents: mockFinalTotalCents,
            },
          ]),
      }),
    }),
  })),
};

jest.mock("drizzle-orm", () => ({
  desc: jest.fn((value: unknown) => value),
  eq: jest.fn((...values: unknown[]) => values),
  inArray: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointments: {
    id: "appointments.id",
    finalTotalCents: "appointments.final_total_cents",
  },
  getDb: () => mockDb,
  paymentAttempts: {},
  paymentRefunds: {},
}));

jest.mock("@/lib/payment-ledger", () => ({
  getAppointmentPaymentSummary: mockGetAppointmentPaymentSummary,
  listAppointmentPaymentRows: mockListAppointmentPaymentRows,
}));

jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { GET as getAppointmentPayments } from "../../app/api/appointments/[id]/payments/route";

function request(): NextRequest {
  return {} as NextRequest;
}

function context() {
  return { params: Promise.resolve({ id: appointmentId }) };
}

describe("appointment payments fallback without the ledger schema", () => {
  beforeEach(() => {
    mockFinalTotalCents = 47_500;
    mockDb.select.mockClear();
    mockListAppointmentPaymentRows.mockClear();
    mockGetAppointmentPaymentSummary.mockClear();
  });

  it.each([
    {
      finalTotalCents: 47_500,
      status: "unknown",
      balanceCents: null,
    },
    {
      finalTotalCents: null,
      status: "unknown",
      balanceCents: null,
    },
  ] as const)(
    "returns a 200 unknown fallback when finalTotalCents is $finalTotalCents",
    async ({ finalTotalCents, status, balanceCents }) => {
      mockFinalTotalCents = finalTotalCents;

      const response = await getAppointmentPayments(request(), context());

      await expect(response.json()).resolves.toEqual({
        appointmentId,
        ledgerAvailable: false,
        paymentSummary: {
          status,
          jobTotalCents: finalTotalCents,
          paidTowardJobCents: 0,
          tipCents: 0,
          refundedCents: 0,
          balanceCents,
          activeAttemptId: null,
          latestReceiptUrl: null,
        },
        payments: [],
        refunds: [],
        attempts: [],
      });
      expect(response.status).toBe(200);
      expect(mockListAppointmentPaymentRows).not.toHaveBeenCalled();
      expect(mockGetAppointmentPaymentSummary).not.toHaveBeenCalled();
    },
  );
});
