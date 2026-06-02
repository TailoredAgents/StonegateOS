import {
  applyFacebookCoachingGuards,
  detectClearBookingConfirmation,
  estimateJunkQuoteRangeFromVolume,
} from "@/lib/facebook-sales-autopilot";
import { DEFAULT_SALES_AUTOPILOT_POLICY } from "@/lib/policy";

describe("facebook sales autopilot helpers", () => {
  const offeredSlots = [
    { label: "Option 1: Fri, May 29 at 10:00 AM", startAt: "2026-05-29T14:00:00.000Z" },
    { label: "Option 2: Sat, May 30 at 1:00 PM", startAt: "2026-05-30T17:00:00.000Z" },
  ];

  it("detects clear confirmation by option number", () => {
    expect(detectClearBookingConfirmation("Yes option 2 works", offeredSlots)).toEqual(offeredSlots[1]);
  });

  it("detects clear confirmation by day and time", () => {
    expect(detectClearBookingConfirmation("Okay Friday at 10 works", offeredSlots)).toEqual(offeredSlots[0]);
  });

  it("rejects vague positive replies when more than one slot was offered", () => {
    expect(detectClearBookingConfirmation("Yes that sounds good", offeredSlots)).toBeNull();
  });

  it("maps junk volume to a usable quote range", () => {
    expect(
      estimateJunkQuoteRangeFromVolume({
        volumeRange: "half_to_three_quarters",
        confidence: "high",
      }),
    ).toEqual({ lowCents: 48000, highCents: 62000, confidence: "high" });
  });

  it("routes owner coaching review keywords to human review", () => {
    expect(
      applyFacebookCoachingGuards({
        body: "Can you remove a hot tub?",
        action: "send_quote_range",
        stage: "quote_ready",
        mediaCount: 2,
        coaching: DEFAULT_SALES_AUTOPILOT_POLICY.facebookCoaching,
      }),
    ).toEqual({
      action: "human_review",
      stage: "needs_human_review",
      reason: "owner_coaching_review_keyword:hot tub",
      humanReviewReason: "owner_coaching_review_keyword:hot tub",
    });
  });

  it("can require photos before quote or time offers", () => {
    expect(
      applyFacebookCoachingGuards({
        body: "How much and can you come tomorrow?",
        action: "offer_times",
        stage: "quote_ready",
        mediaCount: 0,
        coaching: {
          ...DEFAULT_SALES_AUTOPILOT_POLICY.facebookCoaching,
          humanReviewKeywords: [],
          requirePhotosBeforeQuote: true,
        },
      }),
    ).toEqual({
      action: "request_photos",
      stage: "missing_info",
      reason: "owner_coaching_photos_required",
      humanReviewReason: null,
    });
  });
});
