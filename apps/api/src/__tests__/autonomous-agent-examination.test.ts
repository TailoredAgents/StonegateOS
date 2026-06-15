import {
  applyFacebookCoachingGuards,
  buildQuoteMessage,
  detectClearBookingConfirmation,
  detectFacebookSalesRisk,
  getTextQuoteReadiness,
  isSalesAutonomyTestOverrideActive,
} from "@/lib/facebook-sales-autopilot";
import {
  isAfterHoursAutonomyActive,
  validateAutonomousBookingStart,
} from "@/lib/after-hours-autonomy";
import { DEFAULT_SALES_AUTOPILOT_POLICY } from "@/lib/policy";
import { evaluateSalesAutopilotAutosendSafety } from "@/lib/sales-autopilot";

const timezone = "America/New_York";

function contextFromInbound(body: string, overrides: Partial<Parameters<typeof getTextQuoteReadiness>[0]> = {}) {
  return {
    latestLead: null,
    instantQuote: null,
    derived: { knownZip: null, knownCity: null },
    recentMessages: [
      {
        direction: "inbound",
        body,
        mediaUrls: [],
      },
    ],
    ...overrides,
  };
}

describe("autonomous sales agent examination", () => {
  const originalForceOverride = process.env["SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS"];
  const originalTestPhone = process.env["SALES_AUTONOMY_TEST_PHONE_E164"];

  afterEach(() => {
    process.env["SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS"] = originalForceOverride;
    process.env["SALES_AUTONOMY_TEST_PHONE_E164"] = originalTestPhone;
  });

  it("keeps weekday daytime in assist/draft and after-hours in autonomous mode", () => {
    expect(isAfterHoursAutonomyActive({ at: "2026-06-15T12:00:00-04:00", timezone })).toBe(false);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-15T18:30:00-04:00", timezone })).toBe(true);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-16T07:29:00-04:00", timezone })).toBe(true);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-16T07:30:00-04:00", timezone })).toBe(false);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-14T13:00:00-04:00", timezone })).toBe(true);
  });

  it("allows a targeted live-smoke autonomy override only for the configured test phone", () => {
    process.env["SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS"] = "1";
    process.env["SALES_AUTONOMY_TEST_PHONE_E164"] = "+15555550101";

    expect(
      isSalesAutonomyTestOverrideActive({
        row: { channel: "sms", fromAddress: "(555) 555-0101", toAddress: "+14045550100" },
        context: { contact: { phone: "555-555-0101", phoneE164: "+15555550101" } },
      }),
    ).toBe(true);

    expect(
      isSalesAutonomyTestOverrideActive({
        row: { channel: "sms", fromAddress: "+14045550199", toAddress: "+14045550100" },
        context: { contact: { phone: "404-555-0199", phoneE164: "+14045550199" } },
      }),
    ).toBe(false);
  });

  it("keeps the live-smoke override disabled unless the env flag is explicitly enabled", () => {
    process.env["SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS"] = "0";
    process.env["SALES_AUTONOMY_TEST_PHONE_E164"] = "+15555550101";

    expect(
      isSalesAutonomyTestOverrideActive({
        row: { channel: "sms", fromAddress: "+15555550101", toAddress: "+14045550100" },
        context: { contact: { phone: "555-555-0101", phoneE164: "+15555550101" } },
      }),
    ).toBe(false);
  });


  it("asks one quote question at a time for vague text estimates", () => {
    expect(getTextQuoteReadiness(contextFromInbound("I want an estimate over text")).missingQuestion).toBe(
      "What ZIP code is the pickup in?",
    );

    expect(getTextQuoteReadiness(contextFromInbound("How much for a couch in 30144?")).missingQuestion).toBe(
      "About how much is it: single item, small pickup, half trailer, 3/4 trailer, or full trailer?",
    );

    expect(getTextQuoteReadiness(contextFromInbound("I have a half trailer of garage junk")).missingQuestion).toBe(
      "What ZIP code is the pickup in?",
    );
  });

  it("produces a ballpark range only after location, job type, and rough size are known", () => {
    const readiness = getTextQuoteReadiness(contextFromInbound("Half trailer of garage junk in 30144"));
    expect(readiness.missingQuestion).toBeNull();
    expect(readiness.quoteRange).toEqual({ lowCents: 32000, highCents: 47000, confidence: "low" });
  });

  it("always offers a free in-person quote with the ballpark range", () => {
    const body = buildQuoteMessage(
      { lowCents: 32000, highCents: 47000 },
      null,
      DEFAULT_SALES_AUTOPILOT_POLICY.facebookCoaching,
    );
    expect(body).toContain("$320-$470");
    expect(body.toLowerCase()).toContain("free in-person quote");
  });

  it("routes risky or owner-blocked conversations to human review", () => {
    expect(
      detectFacebookSalesRisk({
        latestLead: null,
        instantQuote: null,
        recentMessages: [{ direction: "inbound", body: "Can you remove a hot tub?", mediaUrls: [] }],
      }),
    ).toBe("non_standard_item");

    expect(
      applyFacebookCoachingGuards({
        body: "I want a refund and I am calling a lawyer",
        action: "send_quote_range",
        stage: "quote_ready",
        mediaCount: 0,
        coaching: DEFAULT_SALES_AUTOPILOT_POLICY.facebookCoaching,
      }),
    ).toMatchObject({
      action: "human_review",
      stage: "needs_human_review",
    });
  });

  it("prevents generic sales autopilot autosend for declined or hazardous items", () => {
    expect(
      evaluateSalesAutopilotAutosendSafety({
        inboundBody: "Do you take old paint?",
        draftBody: "Yep, we can take the old paint. With the 25% off, that's still locked in.",
      }),
    ).toEqual({ allowed: false, reason: "declined_or_hazard_item", keyword: "paint" });
  });

  it("prevents generic sales autopilot autosend when the customer asks for time", () => {
    expect(
      evaluateSalesAutopilotAutosendSafety({
        inboundBody: "Let me think about it",
        draftBody: "Just checking back to see if you had a chance to figure out a time.",
      }),
    ).toEqual({ allowed: false, reason: "customer_deferral", keyword: "customer_needs_time" });
  });

  it("books only from an explicit offered slot confirmation", () => {
    const offeredSlots = [
      { label: "Option 1: Tue, Jun 16 at 10:00 AM", startAt: "2026-06-16T14:00:00.000Z" },
      { label: "Option 2: Tue, Jun 16 at 1:00 PM", startAt: "2026-06-16T17:00:00.000Z" },
    ];

    expect(detectClearBookingConfirmation("yes sounds good", offeredSlots)).toBeNull();
    expect(detectClearBookingConfirmation("option 2 works", offeredSlots)).toEqual(offeredSlots[1]);
  });

  it("enforces hard autonomous booking rules used by assist and booking endpoints", () => {
    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-14T10:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "sunday_blocked" });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-15T17:30:00-04:00",
        city: "Marietta",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "late_city_required" });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-15T17:30:00-04:00",
        city: "Kennesaw",
        timezone,
      }),
    ).toEqual({ ok: true });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-20T13:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toEqual({ ok: true });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-20T14:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "outside_booking_hours" });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-16T09:30:00-04:00",
        conversationAt: "2026-06-15T20:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "night_minimum_start" });
  });
});
