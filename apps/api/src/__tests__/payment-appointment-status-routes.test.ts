import type { NextRequest } from "next/server";

let mockAppointmentStatus = "canceled";
let mockAppointmentType = "junk_removal";
const mockGetAppointmentScopeState = jest
  .fn()
  .mockResolvedValue({ needsScope: false });
const mockTransaction = jest.fn(
  async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: () =>
                Promise.resolve([
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    finalTotalCents: 32_500,
                    status: mockAppointmentStatus,
                    type: mockAppointmentType,
                  },
                ]),
            }),
          }),
        }),
      }),
    }),
);

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  desc: jest.fn((value: unknown) => value),
  eq: jest.fn((...values: unknown[]) => values),
  inArray: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointments: {
    id: "appointments.id",
    finalTotalCents: "appointments.final_total_cents",
    status: "appointments.status",
    type: "appointments.type",
  },
  paymentAttempts: {},
  payments: {},
  getDb: () => ({
    transaction: mockTransaction,
  }),
}));

jest.mock("@/lib/appointment-media", () => ({
  AppointmentMediaError: class AppointmentMediaError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  getAppointmentScopeState: mockGetAppointmentScopeState,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({
    id: "22222222-2222-4222-8222-222222222222",
    role: "crew",
  }),
  recordAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/payment-feature-flags", () => ({
  isSquarePosEnabled: () => true,
}));

jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/square-pos", () => ({
  buildSquarePosLaunchUrl: jest.fn(),
  createSquarePosState: jest.fn(),
  squareAttemptNote: jest.fn(),
  verifySquarePosState: jest.fn(),
}));

jest.mock("@/lib/square-payments", () => ({
  hashSquareReturnNonce: jest.fn(),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { POST as createSquareAttempt } from "../../app/api/appointments/[id]/payment-attempts/route";
import { POST as recordManualPayment } from "../../app/api/appointments/[id]/manual-payments/route";

const appointmentId = "11111111-1111-4111-8111-111111111111";

function context() {
  return { params: Promise.resolve({ id: appointmentId }) };
}

function squareRequest(): NextRequest {
  return {
    json: () =>
      Promise.resolve({
        clientRequestId: "33333333-3333-4333-8333-333333333333",
        platform: "ios",
      }),
  } as unknown as NextRequest;
}

function manualRequest(): NextRequest {
  return {
    json: () =>
      Promise.resolve({
        clientRequestId: "44444444-4444-4444-8444-444444444444",
        tenderType: "cash",
        tipCents: 0,
      }),
  } as unknown as NextRequest;
}

describe("payment collection appointment-status boundary", () => {
  const originalSquareEnvironment = {
    applicationId: process.env["SQUARE_APPLICATION_ID"],
    locationId: process.env["SQUARE_LOCATION_ID"],
    callbackUrl: process.env["SQUARE_POS_CALLBACK_URL"],
    fallbackUrl: process.env["SQUARE_POS_FALLBACK_URL"],
    stateSecret: process.env["SQUARE_POS_STATE_SECRET"],
  };

  beforeAll(() => {
    process.env["SQUARE_APPLICATION_ID"] = "square-application";
    process.env["SQUARE_LOCATION_ID"] = "square-location";
    process.env["SQUARE_POS_CALLBACK_URL"] =
      "https://stonegate.example/mobile/payment-return";
    process.env["SQUARE_POS_FALLBACK_URL"] =
      "https://stonegate.example/mobile/square-setup";
    process.env["SQUARE_POS_STATE_SECRET"] = "s".repeat(32);
  });

  beforeEach(() => {
    mockAppointmentStatus = "confirmed";
    mockAppointmentType = "junk_removal";
    mockTransaction.mockClear();
    mockGetAppointmentScopeState.mockClear();
  });

  afterAll(() => {
    for (const [name, value] of Object.entries({
      SQUARE_APPLICATION_ID: originalSquareEnvironment.applicationId,
      SQUARE_LOCATION_ID: originalSquareEnvironment.locationId,
      SQUARE_POS_CALLBACK_URL: originalSquareEnvironment.callbackUrl,
      SQUARE_POS_FALLBACK_URL: originalSquareEnvironment.fallbackUrl,
      SQUARE_POS_STATE_SECRET: originalSquareEnvironment.stateSecret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(["canceled", "no_show"])(
    "rejects a Square attempt for a %s appointment",
    async (status) => {
      mockAppointmentStatus = status;

      const response = await createSquareAttempt(squareRequest(), context());

      await expect(response.json()).resolves.toEqual({
        error: "appointment_not_collectible",
        appointmentStatus: status,
        message:
          "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
      });
      expect(response.status).toBe(409);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockGetAppointmentScopeState).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["canceled", "no_show"])(
    "rejects a manual payment for a %s appointment",
    async (status) => {
      mockAppointmentStatus = status;

      const response = await recordManualPayment(manualRequest(), context());

      await expect(response.json()).resolves.toEqual({
        error: "appointment_not_collectible",
        appointmentStatus: status,
        message:
          "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
      });
      expect(response.status).toBe(409);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockGetAppointmentScopeState).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["in_person_quote", "in_person_estimate"])(
    "rejects a Square attempt for a %s appointment",
    async (type) => {
      mockAppointmentType = type;

      const response = await createSquareAttempt(squareRequest(), context());

      await expect(response.json()).resolves.toEqual({
        error: "appointment_not_collectible",
        appointmentStatus: "confirmed",
        message:
          "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
      });
      expect(response.status).toBe(409);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockGetAppointmentScopeState).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["in_person_quote", "in_person_estimate"])(
    "rejects a manual payment for a %s appointment",
    async (type) => {
      mockAppointmentType = type;

      const response = await recordManualPayment(manualRequest(), context());

      await expect(response.json()).resolves.toEqual({
        error: "appointment_not_collectible",
        appointmentStatus: "confirmed",
        message:
          "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
      });
      expect(response.status).toBe(409);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockGetAppointmentScopeState).toHaveBeenCalledTimes(1);
    },
  );
});
