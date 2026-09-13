import type { NextRequest } from "next/server";
import type * as DatabaseSchema from "@/db/schema";
import type { CalendarCardIdentityRow } from "@/lib/calendar-card-identity";

const mockAppointmentId = "11111111-1111-4111-8111-111111111111";
const mockContactId = "22222222-2222-4222-8222-222222222222";
let mockEnrichmentFailure = false;
let mockIdentityReadCount = 0;
let mockIdentityRows: CalendarCardIdentityRow[] = [];
const mockCoreRow = {
  id: mockAppointmentId,
  contactId: mockContactId,
  type: "job",
  status: "confirmed",
  startAt: new Date("2026-09-12T14:00:00.000Z"),
  durationMinutes: 60,
  rescheduleToken: "test-reschedule",
  quotedTotalCents: 32_500,
  finalTotalCents: 35_000,
  updatedAt: new Date("2026-09-11T13:00:00.000Z"),
  quotedScopeText: "Keep donation bins in place.",
  bookingDetails: null,
  contactFirstName: "Jordan",
  contactLastName: "Smith",
  addressLine1: "123 Oak Street",
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
};

function mockSelect(fields: Record<string, unknown>) {
  const identity = "partnerServiceLabel" in fields;
  const core = "rescheduleToken" in fields;
  const query = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => {
      if (identity) mockIdentityReadCount += 1;
      const promise =
        identity && mockEnrichmentFailure
          ? Promise.reject(new Error("partner table unavailable"))
          : Promise.resolve(
              identity ? mockIdentityRows : core ? [mockCoreRow] : [],
            );
      return promise.then(resolve, reject);
    },
  };
  return query;
}

const mockDb = {
  select: mockSelect,
  transaction: (
    callback: (tx: {
      select: typeof mockSelect;
      execute: () => Promise<void>;
    }) => Promise<unknown>,
  ) => callback({ select: mockSelect, execute: () => Promise.resolve() }),
};

jest.mock("@/db", () => ({
  ...jest.requireActual<typeof DatabaseSchema>("@/db/schema"),
  getDb: () => mockDb,
}));
jest.mock("@/lib/calendar", () => ({
  getAccessToken: jest.fn(),
  getCalendarConfig: jest.fn(),
  isGoogleCalendarEnabled: () => false,
}));
jest.mock("@/lib/appointment-capacity", () => ({
  getAppointmentCapacity: () => 2,
}));
jest.mock("@/lib/eta-agent", () => ({
  getEtaSummariesForAppointments: () => Promise.resolve(new Map()),
}));
jest.mock("@/lib/appointment-media", () => ({
  getAppointmentMediaSummaryMap: () => Promise.resolve(new Map()),
}));
jest.mock("@/lib/payment-ledger", () => ({
  getAppointmentPaymentSummaryMap: jest.fn(),
}));
jest.mock("@/lib/payment-schema", () => ({
  isPaymentLedgerSchemaAvailable: () => Promise.resolve(false),
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: (_request: unknown, permission: string) =>
    Promise.resolve(
      permission === "appointments.read"
        ? null
        : new Response(null, { status: 403 }),
    ),
}));
jest.mock("../../app/api/web/admin", () => ({ isAdminRequest: () => true }));

import { GET } from "../../app/api/admin/calendar/feed/route";

async function readFeed() {
  const response = await GET({
    url: "https://stonegate.example/api/admin/calendar/feed?start=2026-09-12T00%3A00%3A00.000Z&end=2026-09-13T00%3A00%3A00.000Z",
  } as NextRequest);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    appointments: Array<Record<string, unknown>>;
  }>;
}

describe("calendar card identity feed", () => {
  beforeEach(() => {
    mockEnrichmentFailure = false;
    mockIdentityReadCount = 0;
    mockIdentityRows = [
      {
        appointmentId: mockAppointmentId,
        bookingId: "booking-1",
        bookingAccountId: "account-1",
        appointmentAccountId: "account-1",
        accountName: "Oak Property Management",
        partnerServiceKey: "demo-hauloff",
        partnerServiceLabel: "Demolition debris pickup",
      },
    ];
  });

  it("projects partner identity once per job without exposing restricted payment data", async () => {
    const feed = await readFeed();
    expect(mockIdentityReadCount).toBe(1);
    expect(feed.appointments).toHaveLength(1);
    expect(feed.appointments[0]).toMatchObject({
      appointmentId: mockAppointmentId,
      contactId: mockContactId,
      bookingDetails: null,
      status: "confirmed",
      quotedScopeText: "Keep donation bins in place.",
      serviceCategoryLabel: "Demolition debris pickup",
      partnerAffiliation: {
        accountId: "account-1",
        bookingId: "booking-1",
        displayName: "Oak Property Management",
        basis: "partner_booking",
      },
    });
    expect(feed.appointments[0]).not.toHaveProperty("paymentSummary");
    expect(feed.appointments[0]).not.toHaveProperty("finalTotalCents");
    expect(feed.appointments[0]).not.toHaveProperty("contactPhone");
  });

  it("preserves the core feed when partner enrichment fails", async () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      mockEnrichmentFailure = true;
      const feed = await readFeed();
      expect(feed.appointments).toHaveLength(1);
      expect(feed.appointments[0]).toMatchObject({
        appointmentId: mockAppointmentId,
        contactName: "Jordan Smith",
        serviceCategoryLabel: null,
        partnerAffiliation: null,
        status: "confirmed",
      });
      expect(warning).toHaveBeenCalledWith(
        "calendar_card_identity_unavailable",
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("never duplicates the calendar when optional lookup data is duplicated", async () => {
    mockIdentityRows.push({
      ...mockIdentityRows[0]!,
      appointmentId: mockAppointmentId,
    });
    expect((await readFeed()).appointments).toHaveLength(1);
  });
});
