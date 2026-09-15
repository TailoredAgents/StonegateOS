import type { NextRequest } from "next/server";

const appointmentWithTotalId = "11111111-1111-4111-8111-111111111111";
const appointmentWithoutTotalId = "22222222-2222-4222-8222-222222222222";

const mockCalendarRows = [
  {
    id: appointmentWithTotalId,
    contactId: null,
    type: "junk_removal",
    status: "completed",
    startAt: new Date("2026-07-29T14:00:00.000Z"),
    durationMinutes: 60,
    rescheduleToken: "with-total",
    quotedTotalCents: 32_500,
    finalTotalCents: 47_500,
    updatedAt: new Date("2026-07-29T13:00:00.000Z"),
    quotedScopeText: "Quoted work",
    bookingDetails: null,
    contactFirstName: null,
    contactLastName: null,
    addressLine1: null,
    city: null,
    state: null,
    postalCode: null,
  },
  {
    id: appointmentWithoutTotalId,
    contactId: null,
    type: "junk_removal",
    status: "confirmed",
    startAt: new Date("2026-07-29T16:00:00.000Z"),
    durationMinutes: 60,
    rescheduleToken: "without-total",
    quotedTotalCents: 20_000,
    finalTotalCents: null,
    updatedAt: new Date("2026-07-29T15:00:00.000Z"),
    quotedScopeText: null,
    bookingDetails: null,
    contactFirstName: null,
    contactLastName: null,
    addressLine1: null,
    city: null,
    state: null,
    postalCode: null,
  },
];

let mockSelectCall = 0;
let mockCrewRows: Array<Record<string, unknown>> = [];
const mockGetAppointmentPaymentSummaryMap = jest.fn();
const mockRequirePermission = jest.fn().mockResolvedValue(null);

function mockThenableQuery(rows: Array<Record<string, unknown>>) {
  const query = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    then: (
      resolve: (value: Array<Record<string, unknown>>) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

const mockDb = {
  select: jest.fn(() => {
    const rows =
      mockSelectCall === 0
        ? mockCalendarRows
        : mockSelectCall === 2
          ? mockCrewRows
          : [];
    mockSelectCall += 1;
    return mockThenableQuery(rows);
  }),
};

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  desc: jest.fn((value: unknown) => value),
  eq: jest.fn((...values: unknown[]) => values),
  gte: jest.fn((...values: unknown[]) => values),
  inArray: jest.fn((...values: unknown[]) => values),
  lt: jest.fn((...values: unknown[]) => values),
}));

jest.mock("@/db", () => ({
  appointmentCrewMembers: {
    appointmentId: "appointment_crew_members.appointment_id",
    memberId: "appointment_crew_members.member_id",
    hourlyRateCents: "appointment_crew_members.hourly_rate_cents",
    workedMinutes: "appointment_crew_members.worked_minutes",
  },
  appointmentNotes: {
    id: "appointment_notes.id",
    appointmentId: "appointment_notes.appointment_id",
    body: "appointment_notes.body",
    createdAt: "appointment_notes.created_at",
  },
  appointments: {
    id: "appointments.id",
    contactId: "appointments.contact_id",
    propertyId: "appointments.property_id",
    type: "appointments.type",
    status: "appointments.status",
    startAt: "appointments.start_at",
    durationMinutes: "appointments.duration_minutes",
    rescheduleToken: "appointments.reschedule_token",
    quotedTotalCents: "appointments.quoted_total_cents",
    finalTotalCents: "appointments.final_total_cents",
    updatedAt: "appointments.updated_at",
    quotedScopeText: "appointments.quoted_scope_text",
    bookingDetails: "appointments.booking_details",
  },
  contacts: {
    id: "contacts.id",
    firstName: "contacts.first_name",
    lastName: "contacts.last_name",
  },
  crmTasks: {
    id: "crm_tasks.id",
    contactId: "crm_tasks.contact_id",
    notes: "crm_tasks.notes",
    createdAt: "crm_tasks.created_at",
    status: "crm_tasks.status",
    dueAt: "crm_tasks.due_at",
  },
  getDb: () => mockDb,
  properties: {
    id: "properties.id",
    addressLine1: "properties.address_line_1",
    city: "properties.city",
    state: "properties.state",
    postalCode: "properties.postal_code",
  },
  teamMembers: {
    id: "team_members.id",
    name: "team_members.name",
  },
}));

jest.mock("@/lib/calendar", () => ({
  getAccessToken: jest.fn(),
  getCalendarConfig: jest.fn(),
  isGoogleCalendarEnabled: () => false,
}));

jest.mock("@/lib/appointment-capacity", () => ({
  getAppointmentCapacity: () => 2,
}));

jest.mock("@/lib/appointment-booking-details", () => ({
  parseAppointmentBookingDetails: () => null,
}));

jest.mock("@/lib/eta-agent", () => ({
  getEtaSummariesForAppointments: () => Promise.resolve(new Map()),
}));

jest.mock("@/lib/appointment-media", () => ({
  getAppointmentMediaSummaryMap: () => Promise.resolve(new Map()),
}));
jest.mock("@/lib/partner-request-details-store", () => ({
  loadPartnerRequestDetailsForAppointments: () => Promise.resolve(new Map()),
}));

jest.mock("@/lib/payment-ledger", () => ({
  getAppointmentPaymentSummaryMap: mockGetAppointmentPaymentSummaryMap,
}));

jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { GET as getCalendarFeed } from "../../app/api/admin/calendar/feed/route";

function calendarRequest(): NextRequest {
  return {
    url: "https://stonegate.example/api/admin/calendar/feed?start=2026-07-29T00%3A00%3A00.000Z&end=2026-07-30T00%3A00%3A00.000Z",
  } as unknown as NextRequest;
}

describe("calendar payment fallback without the ledger schema", () => {
  beforeEach(() => {
    mockSelectCall = 0;
    mockCrewRows = [];
    mockDb.select.mockClear();
    mockGetAppointmentPaymentSummaryMap.mockClear();
    mockRequirePermission.mockReset();
    mockRequirePermission.mockResolvedValue(null);
  });

  it("keeps final totals and supplies unknown ledger summaries", async () => {
    const response = await getCalendarFeed(calendarRequest());
    const body = (await response.json()) as {
      appointments: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.appointments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appointmentId: appointmentWithTotalId,
          finalTotalCents: 47_500,
          paymentLedgerAvailable: false,
          paymentSummary: {
            status: "unknown",
            jobTotalCents: 47_500,
            paidTowardJobCents: 0,
            tipCents: 0,
            refundedCents: 0,
            balanceCents: null,
            activeAttemptId: null,
            latestReceiptUrl: null,
          },
        }),
        expect.objectContaining({
          appointmentId: appointmentWithoutTotalId,
          finalTotalCents: null,
          paymentLedgerAvailable: false,
          paymentSummary: {
            status: "unknown",
            jobTotalCents: null,
            paidTowardJobCents: 0,
            tipCents: 0,
            refundedCents: 0,
            balanceCents: null,
            activeAttemptId: null,
            latestReceiptUrl: null,
          },
        }),
      ]),
    );
    expect(mockGetAppointmentPaymentSummaryMap).not.toHaveBeenCalled();
  });

  it("does not expose final totals without payments.read", async () => {
    mockRequirePermission.mockImplementation(
      (_request: NextRequest, permission: string) =>
        permission === "payments.read"
          ? new Response(null, { status: 403 })
          : null,
    );

    const response = await getCalendarFeed(calendarRequest());
    const body = (await response.json()) as {
      appointments: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    for (const appointment of body.appointments) {
      expect(appointment).not.toHaveProperty("finalTotalCents");
      expect(appointment).not.toHaveProperty("paymentLedgerAvailable");
      expect(appointment).not.toHaveProperty("paymentSummary");
    }
  });

  it("keeps crew identities but redacts individual pay from calendar-only readers", async () => {
    const memberId = "33333333-3333-4333-8333-333333333333";
    mockCrewRows = [
      {
        appointmentId: appointmentWithTotalId,
        memberId,
        name: "Alex",
        hourlyRateCents: 2750,
        workedMinutes: 135,
      },
    ];
    mockRequirePermission.mockImplementation(
      (_request: NextRequest, permission: string) =>
        permission === "appointments.read"
          ? null
          : new Response(null, { status: 403 }),
    );

    const response = await getCalendarFeed(calendarRequest());
    const body = (await response.json()) as {
      appointments: Array<Record<string, unknown>>;
    };
    expect(response.status).toBe(200);
    const appointment = body.appointments.find(
      (item) => item["appointmentId"] === appointmentWithTotalId,
    );
    expect(appointment).toMatchObject({
      crewMemberIds: [memberId],
      crewNames: ["Alex"],
      crewMembers: [{ memberId }],
    });
    expect(appointment?.["crewMembers"]).toEqual([
      {
        memberId,
        hourlyRateCents: null,
        workedMinutes: null,
      },
    ]);
  });

  it.each(["payments.collect", "commissions.read", "commissions.manage"])(
    "returns saved hourly pay for %s so authorized completion corrections can prefill",
    async (payPermission) => {
      const memberId = "33333333-3333-4333-8333-333333333333";
      mockCrewRows = [
        {
          appointmentId: appointmentWithTotalId,
          memberId,
          name: "Alex",
          hourlyRateCents: 2750,
          workedMinutes: 135,
        },
      ];
      mockRequirePermission.mockImplementation(
        (_request: NextRequest, permission: string | string[]) =>
          (Array.isArray(permission) ? permission : [permission]).some((item) =>
            ["appointments.read", payPermission].includes(item),
          )
            ? null
            : new Response(null, { status: 403 }),
      );

      const response = await getCalendarFeed(calendarRequest());
      const body = (await response.json()) as {
        appointments: Array<Record<string, unknown>>;
      };
      expect(response.status).toBe(200);
      const appointment = body.appointments.find(
        (item) => item["appointmentId"] === appointmentWithTotalId,
      );
      expect(appointment?.["crewMembers"]).toEqual([
        {
          memberId,
          hourlyRateCents: 2750,
          workedMinutes: 135,
        },
      ]);
      expect(appointment).not.toHaveProperty("paymentSummary");
    },
  );
});
