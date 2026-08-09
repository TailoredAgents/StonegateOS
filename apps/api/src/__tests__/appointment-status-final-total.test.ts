import type { NextRequest } from "next/server";
import { NextRequest as RuntimeNextRequest } from "next/server";

const appointmentId = "11111111-1111-4111-8111-111111111111";
const crewMemberId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const currentVersion = new Date("2026-08-08T12:00:00.000Z");
const expectAnyString: unknown = expect.any(String);
const updatedBookingDetails = {
  serviceType: "junk_removal",
  source: { type: "google" },
  pricing: {
    mode: "both",
    rangeMinCents: 30_000,
    rangeMaxCents: 50_000,
  },
  loadSize: { kind: "quarter_to_half" },
};

const mockAppointmentsTable = {
  id: "appointments.id",
  leadId: "appointments.lead_id",
  type: "appointments.type",
  calendarEventId: "appointments.calendar_event_id",
  quotedTotalCents: "appointments.quoted_total_cents",
  bookingDetails: "appointments.booking_details",
  finalTotalCents: "appointments.final_total_cents",
  cardTipCents: "appointments.card_tip_cents",
  status: "appointments.status",
  completedAt: "appointments.completed_at",
  marketingMemberId: "appointments.marketing_member_id",
  updatedAt: "appointments.updated_at",
};
const mockAppointmentCrewMembersTable = {
  appointmentId: "appointment_crew_members.appointment_id",
  memberId: "appointment_crew_members.member_id",
  splitBps: "appointment_crew_members.split_bps",
};
const mockLeadsTable = { id: "leads.id", status: "leads.status" };
const mockOutboxEventsTable = { name: "outbox_events" };
const mockAuditLogsTable = { name: "audit_logs" };
const mockTeamMembersTable = {
  id: "team_members.id",
  active: "team_members.active",
};

type AppointmentState = {
  id: string;
  leadId: string | null;
  type: string;
  calendarEventId: string | null;
  quotedTotalCents: number | null;
  bookingDetails: Record<string, unknown> | null;
  finalTotalCents: number | null;
  cardTipCents: number | null;
  status: string;
  completedAt: Date | null;
  marketingMemberId: string | null;
  updatedAt: Date;
};

let appointment: AppointmentState;
let crewRows: Array<{ memberId: string; splitBps: number }>;
let insertedRows: Array<{ table: unknown; values: unknown }>;
let appointmentUpdateCount: number;
let leadUpdateCount: number;
let getDbCount: number;
let failIdempotencyCompletion: boolean;
let transactionOrder: string[];
let activeTeamMemberIds: Set<string>;

const mockRequirePermission = jest.fn();
const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockSettle = jest.fn();
const mockAssertAppointmentStatusTransitionAllowed = jest.fn();
const mockIsPaymentLedgerSchemaAvailable = jest.fn();
const mockExpireStalePaymentAttempts = jest.fn();
const mockGetBlockingSquareAttempt = jest.fn();
const mockGetFinalTotalPaymentLock = jest.fn();
const mockRequiresSquareAttemptReconciliation = jest.fn();
const mockValidateFinalTotalChange = jest.fn();
const mockKillSwitch = jest.fn();
const mockResolveConfiguredCrewPayout = jest.fn();
const mockLockCompletedPayoutPeriod = jest.fn();
const mockRecalculateCommissions = jest.fn();

function selectBuilder() {
  return {
    from: (table: unknown) => {
      if (table === mockAppointmentCrewMembersTable) {
        return {
          where: () => Promise.resolve(crewRows.map((row) => ({ ...row }))),
        };
      }
      if (table === mockTeamMembersTable) {
        return {
          where: () => ({
            for: () =>
              Promise.resolve(
                [...activeTeamMemberIds].map((id) => ({ id, active: true })),
              ),
          }),
        };
      }
      if (table !== mockAppointmentsTable) {
        throw new Error("unexpected_select_table");
      }
      const appointmentRows = () =>
        Promise.resolve(appointment ? [{ ...appointment }] : []);
      return {
        where: () => ({
          limit: appointmentRows,
          for: () => ({
            limit: appointmentRows,
          }),
        }),
      };
    },
  };
}

function updateBuilder(table: unknown) {
  return {
    set: (values: Record<string, unknown>) => ({
      where: () => {
        if (table === mockLeadsTable) {
          leadUpdateCount += 1;
          return Promise.resolve(undefined);
        }
        if (table !== mockAppointmentsTable) {
          throw new Error("unexpected_update_table");
        }
        return {
          returning: () => {
            appointmentUpdateCount += 1;
            transactionOrder.push("appointment");
            appointment = {
              ...appointment,
              ...(values as Partial<AppointmentState>),
            };
            return Promise.resolve([
              {
                id: appointment.id,
                leadId: appointment.leadId,
                calendarEventId: appointment.calendarEventId,
                updatedAt: appointment.updatedAt,
              },
            ]);
          },
        };
      },
    }),
  };
}

const mockTransaction = {
  select: () => selectBuilder(),
  update: (table: unknown) => updateBuilder(table),
  delete: (table: unknown) => ({
    where: () => {
      if (table === mockAppointmentCrewMembersTable) crewRows = [];
      return Promise.resolve(undefined);
    },
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      transactionOrder.push(
        table === mockAuditLogsTable
          ? "audit"
          : table === mockOutboxEventsTable
            ? "outbox"
            : "insert",
      );
      insertedRows.push({ table, values });
      if (table === mockAppointmentCrewMembersTable && Array.isArray(values)) {
        crewRows = values.map((value) => ({
          memberId: String((value as Record<string, unknown>)["memberId"]),
          splitBps: Number((value as Record<string, unknown>)["splitBps"]),
        }));
      }
      return Promise.resolve(undefined);
    },
  }),
  execute: jest.fn().mockResolvedValue([]),
};

const mockDb = {
  select: () => selectBuilder(),
  transaction: async (
    callback: (transaction: typeof mockTransaction) => Promise<unknown>,
  ) => {
    const appointmentSnapshot = { ...appointment };
    const crewSnapshot = crewRows.map((row) => ({ ...row }));
    const insertedSnapshot = [...insertedRows];
    const updateCountSnapshot = appointmentUpdateCount;
    const leadUpdateCountSnapshot = leadUpdateCount;
    const orderSnapshot = [...transactionOrder];
    try {
      return await callback(mockTransaction);
    } catch (error) {
      appointment = appointmentSnapshot;
      crewRows = crewSnapshot;
      insertedRows = insertedSnapshot;
      appointmentUpdateCount = updateCountSnapshot;
      leadUpdateCount = leadUpdateCountSnapshot;
      transactionOrder = orderSnapshot;
      throw error;
    }
  },
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      insertedRows.push({ table, values });
      return Promise.resolve(undefined);
    },
  }),
};

const mockGetDb = jest.fn(() => {
  getDbCount += 1;
  return mockDb;
});

function mockReplayResponse(input: {
  result: unknown;
  status: number;
  correlationId: string;
}): Response {
  return Response.json(input.result, {
    status: input.status,
    headers: {
      "idempotency-replayed": "true",
      "x-correlation-id": input.correlationId,
    },
  });
}

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  eq: jest.fn((...values: unknown[]) => values),
  inArray: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointments: mockAppointmentsTable,
  appointmentCrewMembers: mockAppointmentCrewMembersTable,
  leads: mockLeadsTable,
  outboxEvents: mockOutboxEventsTable,
  auditLogs: mockAuditLogsTable,
  teamMembers: mockTeamMembersTable,
  getDb: mockGetDb,
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: (...args: unknown[]): unknown =>
    mockRequirePermission(...args) as unknown,
}));

jest.mock("@/lib/team-operation-kill-switch", () => ({
  getTeamOperationKillSwitchForRisk: (...args: unknown[]): unknown =>
    mockKillSwitch(...args) as unknown,
}));

jest.mock("@/lib/commissions", () => ({
  resolveConfiguredCrewPayout: (...args: unknown[]): unknown =>
    mockResolveConfiguredCrewPayout(...args) as unknown,
  lockCompletedAppointmentPayoutPeriodInTransaction: (
    ...args: unknown[]
  ): unknown => mockLockCompletedPayoutPeriod(...args) as unknown,
  recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction: (
    ...args: unknown[]
  ): unknown => mockRecalculateCommissions(...args) as unknown,
}));

jest.mock("@/lib/appointment-media", () => ({
  AppointmentMediaError: class AppointmentMediaError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  assertAppointmentStatusTransitionAllowed: (...args: unknown[]): unknown =>
    mockAssertAppointmentStatusTransitionAllowed(...args) as unknown,
}));

jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: (...args: unknown[]): unknown =>
    mockIsPaymentLedgerSchemaAvailable(...args) as unknown,
}));

jest.mock("@/lib/payment-ledger", () => ({
  expireStalePaymentAttemptsForAppointment: (...args: unknown[]): unknown =>
    mockExpireStalePaymentAttempts(...args) as unknown,
  getBlockingSquareAttempt: (...args: unknown[]): unknown =>
    mockGetBlockingSquareAttempt(...args) as unknown,
  getFinalTotalPaymentLock: (...args: unknown[]): unknown =>
    mockGetFinalTotalPaymentLock(...args) as unknown,
  requiresSquareAttemptReconciliation: (...args: unknown[]): unknown =>
    mockRequiresSquareAttemptReconciliation(...args) as unknown,
  validateFinalTotalChange: (...args: unknown[]): unknown =>
    mockValidateFinalTotalChange(...args) as unknown,
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: (...args: unknown[]): unknown =>
    mockClaim(...args) as unknown,
  completeTeamMutationIdempotency: (...args: unknown[]): unknown =>
    mockComplete(...args) as unknown,
  settleTeamMutationIdempotencyFailure: (...args: unknown[]): unknown =>
    mockSettle(...args) as unknown,
  teamMutationIdempotencyReplayResponse: mockReplayResponse,
}));

import { setVerifiedRequestActor } from "@/lib/verified-actor-context";
import { POST as updateAppointmentStatus } from "../../app/api/appointments/[id]/status/route";

function resetAppointment(overrides: Partial<AppointmentState> = {}): void {
  appointment = {
    id: appointmentId,
    leadId: null,
    type: "junk_removal",
    calendarEventId: null,
    quotedTotalCents: 32_500,
    bookingDetails: null,
    finalTotalCents: null,
    cardTipCents: null,
    status: "confirmed",
    completedAt: null,
    marketingMemberId: null,
    updatedAt: currentVersion,
    ...overrides,
  };
}

function request(
  body: unknown,
  options: {
    version?: string;
    contentLength?: string;
    authenticate?: boolean;
    role?: string;
  } = {},
): NextRequest {
  const version = options.version ?? currentVersion.toISOString();
  const nextRequest = new RuntimeNextRequest(
    `http://crm.test/api/appointments/${appointmentId}/status`,
    {
      method: "POST",
      headers: {
        origin: "http://crm.test",
        host: "crm.test",
        "content-type": "application/json",
        "idempotency-key": "appointment-status:test-key-0001",
        "if-match": `"${version}"`,
        ...(options.contentLength
          ? { "content-length": options.contentLength }
          : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (options.authenticate !== false) {
    setVerifiedRequestActor(nextRequest, {
      type: "human",
      id: actorId,
      role: options.role ?? "crew",
      label: "Crew member",
      sessionId: "session-appointment-status",
      authMethod: "team_session",
    });
  }
  return nextRequest;
}

function context() {
  return { params: Promise.resolve({ id: appointmentId }) };
}

function executeClaim() {
  return {
    kind: "execute" as const,
    claim: {
      id: "claim-1",
      operationId: "claim-operation-1",
      attemptCount: 1,
      principalHash: "p".repeat(64),
      keyHash: "k".repeat(64),
      scopeHash: "s".repeat(64),
      requestHash: "r".repeat(64),
    },
  };
}

describe("appointment status mutation integrity", () => {
  beforeEach(() => {
    resetAppointment();
    crewRows = [{ memberId: crewMemberId, splitBps: 10_000 }];
    insertedRows = [];
    appointmentUpdateCount = 0;
    leadUpdateCount = 0;
    getDbCount = 0;
    failIdempotencyCompletion = false;
    transactionOrder = [];
    activeTeamMemberIds = new Set([crewMemberId]);
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockClaim.mockResolvedValue(executeClaim());
    mockComplete.mockImplementation(
      (
        _tx: unknown,
        _mutation: unknown,
        _claim: unknown,
        _result: unknown,
        _status: unknown,
      ) => {
        transactionOrder.push("idempotency");
        if (failIdempotencyCompletion) {
          throw new Error("idempotency_completion_failed");
        }
        return Promise.resolve();
      },
    );
    mockSettle.mockResolvedValue(undefined);
    mockAssertAppointmentStatusTransitionAllowed.mockResolvedValue(undefined);
    mockIsPaymentLedgerSchemaAvailable.mockResolvedValue(true);
    mockExpireStalePaymentAttempts.mockResolvedValue(undefined);
    mockGetBlockingSquareAttempt.mockResolvedValue(null);
    mockGetFinalTotalPaymentLock.mockResolvedValue({
      paidTowardJobCents: 0,
      hasSuccessfulPayment: false,
    });
    mockRequiresSquareAttemptReconciliation.mockReturnValue(false);
    mockValidateFinalTotalChange.mockReturnValue({ ok: true });
    mockKillSwitch.mockReturnValue(null);
    mockResolveConfiguredCrewPayout.mockImplementation(
      (_database: unknown, memberIds: string[]) =>
        Promise.resolve({
          ok: true,
          splits: memberIds.map((memberId) => ({
            memberId,
            splitBps: 10_000,
          })),
          ruleKey: "solo",
          isFallback: true,
        }),
    );
    mockLockCompletedPayoutPeriod.mockResolvedValue({
      ok: true,
      timezone: "America/New_York",
      periodStart: new Date("2026-08-03T04:00:00.000Z"),
      periodEnd: new Date("2026-08-10T04:00:00.000Z"),
      payoutRunIds: ["55555555-5555-4555-8555-555555555555"],
    });
    mockRecalculateCommissions.mockResolvedValue(undefined);
  });

  it("denies the request before reading params, body, or opening the database", async () => {
    mockRequirePermission.mockResolvedValueOnce(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    let paramsRead = false;
    const deniedContext = {
      get params() {
        paramsRead = true;
        return Promise.resolve({ id: appointmentId });
      },
    };

    const response = await updateAppointmentStatus(
      request({ status: "confirmed" }, { authenticate: false }),
      deniedContext,
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(response.status).toBe(403);
    expect(paramsRead).toBe(false);
    expect(getDbCount).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and oversized bodies before claiming an operation", async () => {
    const malformed = await updateAppointmentStatus(
      request({ status: "confirmed", unexpected: true }),
      context(),
    );
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(malformed.status).toBe(422);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(getDbCount).toBe(0);

    const oversized = await updateAppointmentStatus(
      request({ status: "confirmed" }, { contentLength: String(32_769) }),
      context(),
    );
    await expect(oversized.json()).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      message: "The request body is too large.",
    });
    expect(oversized.status).toBe(413);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("requires payments.collect for money changes before any business mutation", async () => {
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: null,
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.collect"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(appointmentUpdateCount).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("lets an appointments.update-only actor change status without sending anything", async () => {
    const response = await updateAppointmentStatus(
      request({
        status: "no_show",
        expectedVersion: currentVersion.toISOString(),
      }),
      context(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockRequirePermission).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      data: {
        appointmentId,
        status: "no_show",
        customerNotification: "not_requested",
        reviewRequest: "not_requested",
      },
    });
    const statusEvent = insertedRows.find(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] ===
          "estimate.status_changed",
    );
    expect(statusEvent?.values).toMatchObject({
      payload: {
        customerNotificationRequested: false,
        reviewRequestRequested: false,
        messageAuthorization: null,
      },
    });
  });

  it("rejects forged customer-message intent without messages.send", async () => {
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request({
        status: "canceled",
        expectedVersion: currentVersion.toISOString(),
        sendCustomerNotification: true,
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "messages.send"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(appointmentUpdateCount).toBe(0);
    expect(
      insertedRows.filter((entry) => entry.table === mockOutboxEventsTable),
    ).toEqual([]);
    expect(
      insertedRows.some((entry) => entry.table === mockAuditLogsTable),
    ).toBe(true);
  });

  it("honors the external-send kill switch before a requested review mutation", async () => {
    resetAppointment({ finalTotalCents: 47_500 });
    mockKillSwitch.mockImplementation((risk: unknown) =>
      risk === "external" ? "external_sends" : null,
    );

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        sendReviewRequest: true,
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(appointmentUpdateCount).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("honors the external calendar kill switch before cancellation even without a message", async () => {
    mockKillSwitch.mockImplementation((risk: unknown) =>
      risk === "external" ? "external_sends" : null,
    );

    const response = await updateAppointmentStatus(
      request({
        status: "canceled",
        expectedVersion: currentVersion.toISOString(),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(appointmentUpdateCount).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("binds explicit cancellation effects to the success audit without claiming delivery", async () => {
    resetAppointment({ calendarEventId: "google-event-123" });

    const response = await updateAppointmentStatus(
      request({
        status: "canceled",
        expectedVersion: currentVersion.toISOString(),
        sendCustomerNotification: true,
      }),
      context(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        customerNotification: "requested",
        reviewRequest: "not_requested",
        calendarSync: "requested",
      },
    });
    const statusEvent = insertedRows.find(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] ===
          "estimate.status_changed",
    );
    expect(statusEvent?.values).toMatchObject({
      payload: {
        customerNotificationRequested: true,
        reviewRequestRequested: false,
        correlationId: expectAnyString,
        messageAuthorization: {
          auditEventId: expectAnyString,
          actorId,
          operationId: expectAnyString,
          requiredPermission: "messages.send",
        },
      },
    });
    const calendarEvent = insertedRows.find(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] ===
          "appointment.calendar_sync_requested",
    );
    expect(calendarEvent?.values).toMatchObject({
      payload: {
        appointmentId,
        requestedCalendarEventId: "google-event-123",
        sourceAuditEventId: expectAnyString,
        actorId,
        sessionId: "session-appointment-status",
        requiredPermission: "appointments.update",
        reason: "appointment.canceled",
      },
    });
    const auditEvent = insertedRows.find(
      (entry) => entry.table === mockAuditLogsTable,
    );
    expect(auditEvent?.values).toMatchObject({
      meta: {
        before: { calendarEventId: "google-event-123" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("delivered");
    expect(JSON.stringify(body)).not.toContain("sent");
  });

  it("emits a review request only when the newly completed priced job explicitly asks", async () => {
    resetAppointment({ finalTotalCents: 47_500 });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        sendReviewRequest: true,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    const reviewEvents = insertedRows.filter(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] === "review.request",
    );
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0]?.values).toMatchObject({
      payload: {
        appointmentId,
        requested: true,
        messageAuthorization: {
          auditEventId: expectAnyString,
          actorId,
          requiredPermission: "messages.send",
        },
      },
    });
  });

  it("treats quoted booking details as financial and denies an appointment-only grant", async () => {
    resetAppointment({ finalTotalCents: 47_500 });
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        quotedTotalCents: 41_000,
        bookingDetails: updatedBookingDetails,
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.collect"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(appointmentUpdateCount).toBe(0);
  });

  it("rejects booking-detail pricing outside completion", async () => {
    const response = await updateAppointmentStatus(
      request({
        status: "confirmed",
        expectedVersion: currentVersion.toISOString(),
        quotedTotalCents: 41_000,
        bookingDetails: updatedBookingDetails,
      }),
      context(),
    );

    const body = (await response.json()) as {
      ok?: boolean;
      code?: string;
      fieldErrors?: Record<string, string>;
    };
    expect(body).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(typeof body.fieldErrors?.["status"]).toBe("string");
    expect(response.status).toBe(422);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(appointmentUpdateCount).toBe(0);
  });

  it("fails closed without mutating when payment-ledger safety is unavailable", async () => {
    mockIsPaymentLedgerSchemaAvailable.mockResolvedValue(false);

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: null,
      }),
      context(),
    );

    const body = (await response.json()) as {
      ok?: boolean;
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    expect(body).toMatchObject({
      ok: false,
      code: "internal",
      retryable: true,
    });
    expect(body.message).toContain(
      "Payment safety checks are temporarily unavailable",
    );
    expect(response.status).toBe(503);
    expect(appointmentUpdateCount).toBe(0);
    expect(insertedRows).toEqual([]);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("uses effective grants and the strongest policy for a completion-time and money change", async () => {
    const completedAt = "2026-08-08T13:15:00.000Z";

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: null,
        completedAt,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.collect", "payments.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    // The verified actor remains a crew-role member. Authorization comes from
    // the effective permission result above, never from the role slug.
    expect(appointment.completedAt?.toISOString()).toBe(completedAt);
    const claimCalls = mockClaim.mock.calls as unknown[][];
    expect(claimCalls[0]?.[1]).toMatchObject({
      policy: {
        requiredPermissions: [
          "appointments.update",
          "payments.collect",
          "payments.manage",
        ],
      },
      actor: { role: "crew" },
    });
  });

  it("denies an owner-role correction when effective payments.manage is denied", async () => {
    resetAppointment({ finalTotalCents: 40_000 });
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request(
        {
          status: "completed",
          expectedVersion: currentVersion.toISOString(),
          finalTotalCents: 47_500,
          expectedFinalTotalCents: 40_000,
        },
        { role: "owner" },
      ),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.collect", "payments.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(appointmentUpdateCount).toBe(0);
  });

  it("accepts a post-payment correction for a custom-granted non-owner capability", async () => {
    resetAppointment({ finalTotalCents: 40_000 });
    mockGetFinalTotalPaymentLock.mockResolvedValue({
      paidTowardJobCents: 35_000,
      hasSuccessfulPayment: true,
    });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: 40_000,
        finalTotalChangeReason: "Corrected job scope",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.collect", "payments.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockValidateFinalTotalChange).toHaveBeenCalledWith(
      expect.objectContaining({
        canManagePayments: true,
        hasSuccessfulPayment: true,
      }),
    );
    expect(appointment.finalTotalCents).toBe(47_500);
  });

  it("requires commissions.manage before correcting completed-job attribution", async () => {
    resetAppointment({
      status: "completed",
      completedAt: new Date("2026-08-08T13:15:00.000Z"),
      finalTotalCents: 47_500,
    });
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        crewMembers: [{ memberId: crewMemberId, splitBps: 10_000 }],
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "commissions.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRecalculateCommissions).not.toHaveBeenCalled();
  });

  it("requires commissions.manage before moving a completed job back to an active status", async () => {
    resetAppointment({
      status: "completed",
      completedAt: new Date("2026-08-08T13:15:00.000Z"),
      finalTotalCents: 47_500,
    });
    mockRequirePermission
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );

    const response = await updateAppointmentStatus(
      request({
        status: "confirmed",
        expectedVersion: currentVersion.toISOString(),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "commissions.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(appointmentUpdateCount).toBe(0);
    expect(mockRecalculateCommissions).not.toHaveBeenCalled();
  });

  it("rejects moving a completed job into a different payout week", async () => {
    resetAppointment({
      status: "completed",
      completedAt: new Date("2026-08-08T13:15:00.000Z"),
      finalTotalCents: 47_500,
    });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        completedAt: "2026-08-11T12:00:00.000Z",
      }),
      context(),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
      error: "payout_period_change_requires_adjustment",
    });
    expect(response.status).toBe(409);
    expect(mockRequirePermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ["appointments.update", "payments.manage", "commissions.manage"],
      expect.objectContaining({ mode: "all" }),
    );
    expect(appointmentUpdateCount).toBe(0);
    expect(mockRecalculateCommissions).not.toHaveBeenCalled();
  });

  it("rejects a completed-job correction in a locked payout period", async () => {
    resetAppointment({
      status: "completed",
      completedAt: new Date("2026-08-08T13:15:00.000Z"),
      finalTotalCents: 47_500,
    });
    mockLockCompletedPayoutPeriod.mockResolvedValueOnce({
      ok: false,
      reason: "payout_period_finalized",
      timezone: "America/New_York",
      periodStart: new Date("2026-08-03T04:00:00.000Z"),
      periodEnd: new Date("2026-08-10T04:00:00.000Z"),
      finalizedRunId: "55555555-5555-4555-8555-555555555555",
      finalizedRunStatus: "locked",
    });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        crewMembers: [{ memberId: crewMemberId, splitBps: 10_000 }],
      }),
      context(),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
      error: "payout_period_finalized",
    });
    expect(response.status).toBe(409);
    expect(appointmentUpdateCount).toBe(0);
    expect(mockRecalculateCommissions).not.toHaveBeenCalled();
  });

  it("locks submitted attribution members and rejects inactive crew", async () => {
    activeTeamMemberIds.clear();

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: null,
        crewMembers: [{ memberId: crewMemberId, splitBps: 10_000 }],
      }),
      context(),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      error: "inactive_crew_member",
      fieldErrors: { crewMembers: expectAnyString },
    });
    expect(response.status).toBe(422);
    expect(appointmentUpdateCount).toBe(0);
    expect(mockRecalculateCommissions).not.toHaveBeenCalled();
  });

  it("reconciles commission rows and the affected draft report before success", async () => {
    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        finalTotalCents: 47_500,
        expectedFinalTotalCents: null,
        crewMembers: [{ memberId: crewMemberId, splitBps: 10_000 }],
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockRecalculateCommissions).toHaveBeenCalledWith(
      mockTransaction,
      appointmentId,
      { payoutRunIds: ["55555555-5555-4555-8555-555555555555"] },
    );
    const statusEvent = insertedRows.find(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] ===
          "estimate.status_changed",
    );
    expect(statusEvent?.values).not.toHaveProperty(
      "payload.refreshCommissions",
    );
  });

  it("preserves an existing final total and co-commits the receipt after audit and outbox writes", async () => {
    resetAppointment({ finalTotalCents: 47_500 });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
      }),
      context(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        appointmentId,
        status: "completed",
        calendarSync: "not_required",
      },
      receipt: {
        actorId,
        entityType: "appointment",
        entityId: appointmentId,
      },
      appointmentId,
      status: "completed",
    });
    expect(appointment.finalTotalCents).toBe(47_500);
    expect(appointmentUpdateCount).toBe(1);
    expect(
      insertedRows.some(
        (entry) =>
          entry.table === mockOutboxEventsTable &&
          (entry.values as Record<string, unknown>)["type"] ===
            "estimate.status_changed",
      ),
    ).toBe(true);
    expect(
      insertedRows.some((entry) => entry.table === mockAuditLogsTable),
    ).toBe(true);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(transactionOrder.at(-1)).toBe("idempotency");
    expect(transactionOrder.indexOf("audit")).toBeLessThan(
      transactionOrder.indexOf("idempotency"),
    );
  });

  it("saves validated booking details in the same versioned status receipt", async () => {
    resetAppointment({ finalTotalCents: 47_500 });

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        quotedTotalCents: 41_000,
        bookingDetails: updatedBookingDetails,
      }),
      context(),
    );
    const body = (await response.json()) as {
      data?: { bookingDetailsUpdated?: boolean; version?: string };
      receipt?: { version?: string };
    };

    expect(response.status).toBe(200);
    expect(appointment.quotedTotalCents).toBe(41_000);
    expect(appointment.bookingDetails).toEqual({
      ...updatedBookingDetails,
      loadSize: {
        ...updatedBookingDetails.loadSize,
        customLoads: null,
      },
    });
    expect(body.data?.bookingDetailsUpdated).toBe(true);
    expect(body.data?.version).toBe(appointment.updatedAt.toISOString());
    expect(body.receipt?.version).toBe(appointment.updatedAt.toISOString());
    const completionCalls = mockComplete.mock.calls as unknown[][];
    expect(completionCalls[0]?.[3]).toMatchObject({
      data: { bookingDetailsUpdated: true },
      receipt: { version: appointment.updatedAt.toISOString() },
    });
  });

  it("marks a fresh-key same-status outbox event as unchanged", async () => {
    resetAppointment({ leadId: "44444444-4444-4444-8444-444444444444" });
    const response = await updateAppointmentStatus(
      request({
        status: "confirmed",
        expectedVersion: currentVersion.toISOString(),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    const statusEvent = insertedRows.find(
      (entry) =>
        entry.table === mockOutboxEventsTable &&
        (entry.values as Record<string, unknown>)["type"] ===
          "estimate.status_changed",
    );
    expect(statusEvent?.values).toMatchObject({
      payload: {
        appointmentId,
        status: "confirmed",
        statusChanged: false,
      },
    });
    expect(leadUpdateCount).toBe(0);
  });

  it("stores a stale-version conflict and replays the exact lost response without another write", async () => {
    const staleRequest = () =>
      request(
        {
          status: "completed",
          expectedVersion: "2026-08-08T11:59:59.000Z",
        },
        { version: "2026-08-08T11:59:59.000Z" },
      );
    const first = await updateAppointmentStatus(staleRequest(), context());
    const firstBody = (await first.json()) as unknown;

    expect(first.status).toBe(409);
    expect(firstBody).toMatchObject({
      ok: false,
      code: "conflict",
      error: "appointment_changed",
      currentVersion: currentVersion.toISOString(),
    });
    expect(appointmentUpdateCount).toBe(0);
    const completionCalls = mockComplete.mock.calls as unknown[][];
    const storedResult = completionCalls[0]?.[3];
    const storedStatus = Number(completionCalls[0]?.[4]);
    expect(storedResult).toEqual(firstBody);
    expect(storedStatus).toBe(409);

    mockClaim.mockResolvedValueOnce({
      kind: "replay",
      replay: {
        result: storedResult,
        status: storedStatus,
        correlationId: "calendar-status-replay",
      },
    });
    const replay = await updateAppointmentStatus(staleRequest(), context());
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(replay.status).toBe(409);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(appointmentUpdateCount).toBe(0);
  });

  it("replays an exact successful lost response without duplicating linked writes", async () => {
    resetAppointment({ finalTotalCents: 47_500 });
    const completionRequest = () =>
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
      });
    const first = await updateAppointmentStatus(completionRequest(), context());
    const firstBody = (await first.json()) as unknown;
    const insertedAfterFirst = insertedRows.length;
    const completionCalls = mockComplete.mock.calls as unknown[][];
    const storedResult = completionCalls[0]?.[3];
    const storedStatus = Number(completionCalls[0]?.[4]);

    mockClaim.mockResolvedValueOnce({
      kind: "replay",
      replay: {
        result: storedResult,
        status: storedStatus,
        correlationId: "calendar-status-replay",
      },
    });
    const replay = await updateAppointmentStatus(
      completionRequest(),
      context(),
    );

    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(appointmentUpdateCount).toBe(1);
    expect(insertedRows).toHaveLength(insertedAfterFirst);
  });

  it("rolls back status, outbox, and audit writes when idempotency completion fails", async () => {
    resetAppointment({ finalTotalCents: 47_500 });
    failIdempotencyCompletion = true;

    const response = await updateAppointmentStatus(
      request({
        status: "completed",
        expectedVersion: currentVersion.toISOString(),
        quotedTotalCents: 41_000,
        bookingDetails: updatedBookingDetails,
      }),
      context(),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "internal",
      retryable: true,
    });
    expect(response.status).toBe(500);
    expect(appointment.status).toBe("confirmed");
    expect(appointment.quotedTotalCents).toBe(32_500);
    expect(appointment.bookingDetails).toBeNull();
    expect(appointment.updatedAt).toEqual(currentVersion);
    expect(appointmentUpdateCount).toBe(0);
    expect(insertedRows).toEqual([]);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});
