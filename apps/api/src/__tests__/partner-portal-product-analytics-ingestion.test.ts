import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const webEvents = { createdAt: "web_events.created_at" };
const webVitals = { createdAt: "web_vitals.created_at" };
const webEventCountsDaily = {
  count: "web_event_counts_daily.count",
  dateStart: "web_event_counts_daily.date_start",
  event: "web_event_counts_daily.event",
  path: "web_event_counts_daily.path",
  key: "web_event_counts_daily.key",
  device: "web_event_counts_daily.device",
  inAreaBucket: "web_event_counts_daily.in_area_bucket",
  utmSource: "web_event_counts_daily.utm_source",
  utmMedium: "web_event_counts_daily.utm_medium",
  utmCampaign: "web_event_counts_daily.utm_campaign",
  utmTerm: "web_event_counts_daily.utm_term",
  utmContent: "web_event_counts_daily.utm_content",
};
const insertedEvents: Array<Record<string, unknown>> = [];
const insertedCounts: Array<Record<string, unknown>> = [];
const deletedTables: unknown[] = [];
const mockGetServiceAreaPolicy = jest.fn();

const database = {
  delete: jest.fn((table: unknown) => ({
    where: jest.fn(() => {
      deletedTables.push(table);
      return Promise.resolve();
    }),
  })),
  insert: jest.fn((table: unknown) => ({
    values: jest.fn((values: unknown) => {
      const rows = (Array.isArray(values) ? values : [values]) as Array<
        Record<string, unknown>
      >;
      if (table === webEvents) insertedEvents.push(...rows);
      if (table === webEventCountsDaily) insertedCounts.push(...rows);
      return { onConflictDoUpdate: jest.fn(() => Promise.resolve()) };
    }),
  })),
};

mockModule("@/db", () => ({
  getDb: () => database,
  webEventCountsDaily,
  webEvents,
  webVitals,
}));
mockModule("@/lib/policy", () => ({
  getServiceAreaPolicy: mockGetServiceAreaPolicy,
  isGeorgiaPostalCode: () => false,
  isPostalCodeAllowed: () => false,
  normalizePostalCode: (value: string) => value.trim(),
}));

const { POST } = await import("../../app/api/public/web-events/route");

function request(event: Record<string, unknown>): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/public/web-events",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    },
  );
}

describe("Partner product analytics ingestion", () => {
  beforeEach(() => {
    insertedEvents.length = 0;
    insertedCounts.length = 0;
    deletedTables.length = 0;
    mockGetServiceAreaPolicy.mockReset();
  });

  it("server-scrubs private dimensions and remains available when ZIP policy is unavailable", async () => {
    mockGetServiceAreaPolicy.mockRejectedValue(
      new Error("service-area provider unavailable"),
    );
    const response = await POST(
      request({
        sessionId: "session_12345678",
        visitId: "visit_12345678",
        event: "partner_funnel",
        path: "/partners/bookings/108b85dd-d34e-4e00-a842-6257ab8589aa?po=private",
        key: "availability_slot_full:property_manager",
        referrer: "https://private.example/customer",
        utm: { campaign: "private-campaign" },
        zip: "30301",
        meta: {
          surface: "booking",
          step: 4,
          address: "1 Private Street",
          filename: "private.jpg",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockGetServiceAreaPolicy).not.toHaveBeenCalled();
    expect(insertedEvents).toEqual([
      expect.objectContaining({
        event: "partner_funnel",
        path: "/partners/bookings/[job]",
        key: "availability_slot_full:property_manager",
        referrerDomain: null,
        utmCampaign: null,
        inAreaBucket: null,
        meta: { surface: "booking", step: 4 },
      }),
    ]);
    expect(insertedCounts).toEqual([
      expect.objectContaining({
        event: "partner_funnel",
        path: "/partners/bookings/[job]",
        key: "availability_slot_full:property_manager",
        utmCampaign: "",
        inAreaBucket: "",
      }),
    ]);
    expect(JSON.stringify(insertedEvents)).not.toMatch(
      /Private Street|private\.jpg|private-campaign|30301|private\.example|session_12345678|visit_12345678/iu,
    );
    expect(deletedTables).toEqual(
      expect.arrayContaining([webEvents, webVitals]),
    );
  });

  it("ignores unknown Partner event schemas instead of storing arbitrary keys", async () => {
    const response = await POST(
      request({
        sessionId: "session_12345678",
        visitId: "visit_12345678",
        event: "partner_private_record",
        path: "/partners/settings",
        key: "person@example.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(insertedEvents).toEqual([]);
    expect(insertedCounts).toEqual([]);
  });

  it("fails closed for generic events on Partner paths", async () => {
    const response = await POST(
      request({
        sessionId: "person@example.com",
        visitId: "PO-PRIVATE-12345",
        event: "form_submit",
        path: "/partners/settings",
        key: "1 Private Street",
        meta: {
          filename: "private.jpg",
          po: "PO-PRIVATE-12345",
          costCenter: "private-cost-center",
          gateCode: "1234",
          billing: "private-billing-data",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(insertedEvents).toEqual([]);
    expect(insertedCounts).toEqual([]);
  });
});
