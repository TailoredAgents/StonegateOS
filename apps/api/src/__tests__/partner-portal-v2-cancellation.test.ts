import {
  DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES,
  evaluatePartnerCancellation,
  resolvePartnerCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";

const policy = resolvePartnerCancellationPolicy({
  timezone: "America/New_York",
});

describe("partner portal V2 cancellation policy", () => {
  it("uses the explicit 24-hour launch default and never defines an automatic fee", () => {
    expect(policy).toEqual({
      cutoffMinutes: DEFAULT_PARTNER_CANCELLATION_CUTOFF_MINUTES,
      timezone: "America/New_York",
      automaticFeeMinor: null,
      source: "launch_default",
    });
    expect(
      resolvePartnerCancellationPolicy({
        timezone: "not/a-timezone",
      }),
    ).toMatchObject({
      cutoffMinutes: 24 * 60,
      timezone: "America/New_York",
      automaticFeeMinor: null,
    });
  });

  it("cancels a confirmed job before the cutoff without applying a fee", () => {
    const result = evaluatePartnerCancellation({
      status: "confirmed",
      promisedArrivalStartAt: new Date("2026-09-10T14:00:00.000Z"),
      now: new Date("2026-09-09T13:59:59.999Z"),
      canCancel: true,
      reviewPending: false,
      policy,
    });

    expect(result).toMatchObject({
      action: "cancel",
      reason: { code: "before_cutoff" },
      deadlineAt: "2026-09-09T14:00:00.000Z",
      consequence: {
        code: "cancel_without_automatic_fee",
        automaticFeeMinor: null,
      },
    });
  });

  it("routes the exact cutoff and later requests to staff review", () => {
    const input = {
      status: "confirmed",
      promisedArrivalStartAt: new Date("2026-09-10T14:00:00.000Z"),
      canCancel: true,
      reviewPending: false,
      policy,
    } as const;

    for (const now of [
      new Date("2026-09-09T14:00:00.000Z"),
      new Date("2026-09-10T13:00:00.000Z"),
    ]) {
      expect(evaluatePartnerCancellation({ ...input, now })).toMatchObject({
        action: "request_cancellation_review",
        reason: { code: "cutoff_elapsed" },
        consequence: {
          code: "staff_review_without_automatic_fee",
          automaticFeeMinor: null,
        },
      });
    }
  });

  it("uses elapsed time across the spring DST boundary and carries the display timezone", () => {
    // Mar 8, 2026 10:00 EDT is 14:00Z. Twenty-four elapsed hours earlier is
    // Mar 7, 09:00 EST (14:00Z), not 10:00 local time.
    const result = evaluatePartnerCancellation({
      status: "confirmed",
      promisedArrivalStartAt: new Date("2026-03-08T14:00:00.000Z"),
      now: new Date("2026-03-07T13:59:59.999Z"),
      canCancel: true,
      reviewPending: false,
      policy,
    });

    expect(result.deadlineAt).toBe("2026-03-07T14:00:00.000Z");
    expect(result.timezone).toBe("America/New_York");
    expect(result.action).toBe("cancel");
    expect(
      evaluatePartnerCancellation({
        status: "confirmed",
        promisedArrivalStartAt: new Date("2026-03-08T14:00:00.000Z"),
        now: new Date("2026-03-07T14:00:00.000Z"),
        canCancel: true,
        reviewPending: false,
        policy,
      }).action,
    ).toBe("request_cancellation_review");
  });

  it("lets unconfirmed requests cancel directly and treats started work conservatively", () => {
    expect(
      evaluatePartnerCancellation({
        status: "under_review",
        promisedArrivalStartAt: null,
        now: new Date("2026-09-01T12:00:00.000Z"),
        canCancel: true,
        reviewPending: false,
        policy,
      }),
    ).toMatchObject({
      action: "cancel",
      reason: { code: "request_not_confirmed" },
    });
    expect(
      evaluatePartnerCancellation({
        status: "en_route",
        promisedArrivalStartAt: new Date("2026-09-01T14:00:00.000Z"),
        now: new Date("2026-09-01T12:00:00.000Z"),
        canCancel: true,
        reviewPending: false,
        policy,
      }),
    ).toMatchObject({
      action: "request_cancellation_review",
      reason: { code: "service_in_progress" },
    });
  });

  it("makes a durable pending review non-repeatable", () => {
    expect(
      evaluatePartnerCancellation({
        status: "confirmed",
        promisedArrivalStartAt: new Date("2026-09-01T14:00:00.000Z"),
        now: new Date("2026-09-01T12:00:00.000Z"),
        canCancel: true,
        reviewPending: true,
        policy,
      }),
    ).toMatchObject({
      action: null,
      reason: { code: "review_pending" },
      consequence: {
        code: "review_pending_without_automatic_fee",
        automaticFeeMinor: null,
      },
    });
  });
});
