import type { NextRequest } from "next/server";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const finalTotalCents = 47_500;

const mockAppointmentsTable = {
  id: "appointments.id",
  status: "appointments.status",
  finalTotalCents: "appointments.final_total_cents",
};

const mockUpdate = jest.fn();
const mockExpireStalePaymentAttemptsForAppointment = jest.fn();
const mockGetBlockingSquareAttempt = jest.fn();
const mockGetFinalTotalPaymentLock = jest.fn().mockResolvedValue({
  paidTowardJobCents: 0,
  hasSuccessfulPayment: false,
});
const mockValidateFinalTotalChange = jest.fn().mockReturnValue({ ok: true });
const mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts = jest
  .fn()
  .mockResolvedValue(undefined);
const mockRecordAuditEvent = jest.fn().mockResolvedValue(undefined);

const mockTransaction = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: () =>
            Promise.resolve([
              {
                id: appointmentId,
                status: "completed",
                finalTotalCents,
              },
            ]),
        }),
      }),
    }),
  }),
  update: mockUpdate,
};

const mockDb = {
  transaction: async (
    callback: (transaction: typeof mockTransaction) => Promise<unknown>,
  ) => callback(mockTransaction),
};

jest.mock("drizzle-orm", () => ({
  eq: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointments: mockAppointmentsTable,
  getDb: () => mockDb,
}));

jest.mock("@/lib/payment-ledger", () => ({
  expireStalePaymentAttemptsForAppointment:
    mockExpireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt: mockGetBlockingSquareAttempt,
  getFinalTotalPaymentLock: mockGetFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation: jest.fn(),
  validateFinalTotalChange: mockValidateFinalTotalChange,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({
    id: "22222222-2222-4222-8222-222222222222",
    role: "owner",
  }),
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("@/lib/commissions", () => ({
  recalculateAppointmentCommissionsAndRefreshDraftPayouts:
    mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { PUT as updateFinalTotal } from "../../app/api/appointments/[id]/final-total/route";

function retryRequest(): NextRequest {
  return {
    json: () => Promise.resolve({ finalTotalCents }),
  } as unknown as NextRequest;
}

describe("appointment final-total retry", () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockExpireStalePaymentAttemptsForAppointment.mockClear();
    mockGetBlockingSquareAttempt.mockClear();
    mockGetFinalTotalPaymentLock.mockClear();
    mockValidateFinalTotalChange.mockClear();
    mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts.mockClear();
    mockRecordAuditEvent.mockClear();
  });

  it("recalculates a completed job when an idempotent retry matches the stored total", async () => {
    // The first request may commit the total before commission refresh fails.
    // Retrying the same total must repair commissions and draft payout reports.
    const response = await updateFinalTotal(retryRequest(), {
      params: Promise.resolve({ id: appointmentId }),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      appointmentId,
      finalTotalCents,
    });
    expect(response.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(
      mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
    ).toHaveBeenCalledWith(mockDb, appointmentId);
  });
});
