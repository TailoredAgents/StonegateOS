import {
  buildGoogleCalendarEventId,
  createCalendarEvent,
  updateCalendarEvent,
  type AppointmentCalendarPayload,
} from "@/lib/calendar";

const mockQueueMessage = jest.fn().mockResolvedValue({});
const mockGenerateCopy = jest.fn().mockResolvedValue(null);

jest.mock("@/lib/system-outbound", () => ({
  queueSystemOutboundMessage: mockQueueMessage,
}));
jest.mock("@/lib/ai", () => ({
  generateEstimateNotificationCopy: mockGenerateCopy,
  generateQuoteNotificationCopy: jest.fn(),
}));
jest.mock("@/lib/messaging", () => ({
  sendEmailMessage: jest.fn(),
  sendSmsMessage: jest.fn(),
}));

import {
  sendEstimateConfirmation,
  sendEstimateReminder24h,
  type EstimateNotificationPayload,
} from "@/lib/notifications";

const property = {
  addressLine1: "123 Oak Street",
  addressLine2: "Building B, Unit 204",
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
};
const fullAddress = "123 Oak Street, Building B, Unit 204, Atlanta, GA 30301";
const calendarPayload: AppointmentCalendarPayload = {
  appointmentId: "11111111-1111-4111-8111-111111111111",
  startAt: new Date("2026-09-16T14:00:00.000Z"),
  durationMinutes: 60,
  travelBufferMinutes: 15,
  services: ["Junk removal"],
  contact: { name: "Jordan Smith", email: "jordan@example.test" },
  property,
};
const calendarEventId = buildGoogleCalendarEventId(
  calendarPayload.appointmentId,
)!;

describe("booking addresses sent to calendar providers", () => {
  const env = {
    GOOGLE_CALENDAR_ENABLED: "1",
    GOOGLE_CLIENT_ID: "unit-address-test-client",
    GOOGLE_CLIENT_SECRET: "unit-address-test-secret",
    GOOGLE_REFRESH_TOKEN: "unit-address-test-refresh",
    GOOGLE_CALENDAR_ID: "unit-address-test-calendar",
    GOOGLE_CALENDAR_API_BASE_URL: "https://www.googleapis.com/calendar/v3",
    GOOGLE_CALENDAR_TOKEN_URL: "https://oauth2.googleapis.com/token",
  };
  let previous: Record<string, string | undefined>;
  let fetchSpy: jest.SpyInstance;
  let eventBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    eventBodies = [];
    fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        if (init?.body instanceof URLSearchParams) {
          return Response.json({
            access_token: "test-access",
            expires_in: 3600,
          });
        }
        eventBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return Response.json({ id: calendarEventId, status: "confirmed" });
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps the building and unit in Google event locations and descriptions on create and update", async () => {
    expect(await createCalendarEvent(calendarPayload)).toBe(calendarEventId);
    expect(await updateCalendarEvent(calendarEventId, calendarPayload)).toBe(
      true,
    );
    expect(eventBodies).toHaveLength(2);
    for (const body of eventBodies) {
      expect(body.location).toBe(fullAddress);
      expect(body.description).toContain(`Location: ${fullAddress}`);
    }
  });
});

describe("booking addresses in confirmation and reminder emails", () => {
  const notification: EstimateNotificationPayload = {
    leadId: "test-lead",
    contactId: "22222222-2222-4222-8222-222222222222",
    services: calendarPayload.services,
    contact: calendarPayload.contact,
    property,
    scheduling: { preferredDate: null, alternateDate: null, timeWindow: null },
    appointment: {
      id: calendarPayload.appointmentId,
      startAt: calendarPayload.startAt,
      durationMinutes: 60,
      travelBufferMinutes: 15,
      status: "confirmed",
      rescheduleToken: "test-reschedule",
      rescheduleUrl: "https://stonegate.example/reschedule/test",
    },
  };

  beforeEach(() => {
    mockQueueMessage.mockClear();
    mockGenerateCopy.mockClear();
  });

  it("includes building and unit in confirmation email, attached calendar, and copy input", async () => {
    await sendEstimateConfirmation(notification);
    expect(mockQueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        body: expect.stringContaining(`Location: ${fullAddress}`),
        metadata: expect.objectContaining({
          emailAttachments: [
            expect.objectContaining({
              content: expect.stringContaining(
                `LOCATION:${fullAddress.replace(/,/gu, "\\,")}`,
              ),
            }),
          ],
        }),
      }),
    );
    expect(mockGenerateCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining({
          line1: "123 Oak Street, Building B, Unit 204",
        }),
      }),
    );
  });

  it("includes building and unit in reminder email", async () => {
    await sendEstimateReminder24h(notification);
    expect(mockQueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        body: expect.stringContaining(`Location: ${fullAddress}`),
      }),
    );
  });
});
