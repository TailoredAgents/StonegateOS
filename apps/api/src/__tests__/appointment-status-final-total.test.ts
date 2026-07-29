import type { NextRequest } from "next/server";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const crewMemberId = "22222222-2222-4222-8222-222222222222";

let existingFinalTotalCents: number | null = null;
let persistedFinalTotalCents: number | null = null;

const mockUpdateSet = jest.fn();
const mockAssertAppointmentStatusTransitionAllowed = jest
  .fn()
  .mockResolvedValue(undefined);
const mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts = jest
  .fn()
  .mockResolvedValue(undefined);

const mockAppointmentsTable = {
  id: "appointments.id",
  leadId: "appointments.lead_id",
  type: "appointments.type",
  calendarEventId: "appointments.calendar_event_id",
  quotedTotalCents: "appointments.quoted_total_cents",
  finalTotalCents: "appointments.final_total_cents",
  status: "appointments.status",
};
const mockAppointmentCrewMembersTable = {
  appointmentId: "appointment_crew_members.appointment_id",
  memberId: "appointment_crew_members.member_id",
  splitBps: "appointment_crew_members.split_bps",
};
const mockLeadsTable = {
  id: "leads.id",
  status: "leads.status",
};
const mockOutboxEventsTable = {};

function appointmentRows() {
  return [
    {
      id: appointmentId,
      leadId: null,
      type: "junk_removal",
      calendarEventId: null,
      quotedTotalCents: 32_500,
      finalTotalCents: existingFinalTotalCents,
      status: "confirmed",
    },
  ];
}

function selectableRows(rows: Array<Record<string, unknown>>) {
  const result = Promise.resolve(rows) as Promise<
    Array<Record<string, unknown>>
  > & {
    for: () => Promise<Array<Record<string, unknown>>>;
  };
  result.for = () => Promise.resolve(rows);
  return result;
}

function selectBuilder() {
  return {
    from: (table: unknown) => ({
      where: () => {
        if (table === mockAppointmentCrewMembersTable) {
          return Promise.resolve([
            {
              memberId: crewMemberId,
              splitBps: 10_000,
            },
          ]);
        }

        return {
          limit: () => selectableRows(appointmentRows()),
        };
      },
    }),
  };
}

function updateBuilder() {
  return {
    set: (values: Record<string, unknown>) => {
      mockUpdateSet(values);
      if (Object.hasOwn(values, "finalTotalCents")) {
        persistedFinalTotalCents = values["finalTotalCents"] as number | null;
      }

      return {
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: appointmentId,
                leadId: null,
                calendarEventId: null,
              },
            ]),
        }),
      };
    },
  };
}

const mockDb = {
  select: () => selectBuilder(),
  transaction: async (
    callback: (transaction: typeof mockTransaction) => Promise<unknown>,
  ) => callback(mockTransaction),
  insert: () => ({
    values: () => Promise.resolve(undefined),
  }),
  update: () => updateBuilder(),
};

const mockTransaction = {
  select: () => selectBuilder(),
  update: () => updateBuilder(),
  delete: () => ({
    where: () => Promise.resolve(undefined),
  }),
  insert: () => ({
    values: () => Promise.resolve(undefined),
  }),
};

jest.mock("drizzle-orm", () => ({
  eq: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointments: mockAppointmentsTable,
  appointmentCrewMembers: mockAppointmentCrewMembersTable,
  leads: mockLeadsTable,
  outboxEvents: mockOutboxEventsTable,
  getDb: () => mockDb,
}));

jest.mock("@/lib/appointment-media", () => ({
  AppointmentMediaError: class AppointmentMediaError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  assertAppointmentStatusTransitionAllowed:
    mockAssertAppointmentStatusTransitionAllowed,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({
    id: "33333333-3333-4333-8333-333333333333",
    role: "crew",
  }),
  recordAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/calendar", () => ({
  deleteCalendarEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/commissions", () => ({
  getOrCreateCommissionSettings: jest
    .fn()
    .mockResolvedValue({ marketingMemberId: null }),
  recalculateAppointmentCommissionsAndRefreshDraftPayouts:
    mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
}));

jest.mock("@/lib/locked-crew-payout", () => ({
  resolveLockedCrewPayout: jest.fn(),
}));

jest.mock("@/lib/payment-ledger", () => ({
  expireStalePaymentAttemptsForAppointment: jest.fn(),
  getBlockingSquareAttempt: jest.fn(),
  getFinalTotalPaymentLock: jest.fn(),
  requiresSquareAttemptReconciliation: jest.fn(),
  validateFinalTotalChange: jest.fn(),
}));

jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: jest.fn(),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { POST as updateAppointmentStatus } from "../../app/api/appointments/[id]/status/route";

function completionRequest(
  overrides: Record<string, unknown> = {},
): NextRequest {
  return {
    json: () =>
      Promise.resolve({
        status: "completed",
        ...overrides,
      }),
  } as unknown as NextRequest;
}

function context() {
  return {
    params: Promise.resolve({ id: appointmentId }),
  };
}

describe("appointment completion final-total requirement", () => {
  beforeEach(() => {
    existingFinalTotalCents = null;
    persistedFinalTotalCents = null;
    mockUpdateSet.mockClear();
    mockAssertAppointmentStatusTransitionAllowed.mockClear();
    mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts.mockClear();
  });

  it("rejects completion of a non-quote job without a submitted or existing final total", async () => {
    const response = await updateAppointmentStatus(
      completionRequest(),
      context(),
    );

    await expect(response.json()).resolves.toEqual({
      error: "final_total_required",
      message: "Enter the final job total before marking complete.",
    });
    expect(response.status).toBe(400);
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(
      mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
    ).not.toHaveBeenCalled();
  });

  it("preserves an existing final total when the completion payload omits it", async () => {
    existingFinalTotalCents = 47_500;
    persistedFinalTotalCents = existingFinalTotalCents;

    const response = await updateAppointmentStatus(
      completionRequest(),
      context(),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      appointmentId,
      status: "completed",
    });
    expect(response.status).toBe(200);
    expect(persistedFinalTotalCents).toBe(47_500);
    const updateCalls = mockUpdateSet.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(updateCalls).toHaveLength(1);
    expect(Object.hasOwn(updateCalls[0]![0], "finalTotalCents")).toBe(false);
    expect(
      mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
    ).toHaveBeenCalledWith(mockDb, appointmentId);
  });

  it("rejects a stale completion total instead of overwriting a newer value", async () => {
    existingFinalTotalCents = 47_500;
    persistedFinalTotalCents = existingFinalTotalCents;

    const response = await updateAppointmentStatus(
      completionRequest({
        finalTotalCents: 32_500,
        expectedFinalTotalCents: 32_500,
      }),
      context(),
    );

    await expect(response.json()).resolves.toEqual({
      error: "final_total_changed",
      message:
        "The final job total changed on another screen or phone. Review the current amount and try again.",
      currentFinalTotalCents: 47_500,
    });
    expect(response.status).toBe(409);
    expect(persistedFinalTotalCents).toBe(47_500);
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(
      mockRecalculateAppointmentCommissionsAndRefreshDraftPayouts,
    ).not.toHaveBeenCalled();
  });
});
