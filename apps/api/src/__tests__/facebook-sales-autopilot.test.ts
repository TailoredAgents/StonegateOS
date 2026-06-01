import {
  detectClearBookingConfirmation,
  estimateJunkQuoteRangeFromVolume,
} from "@/lib/facebook-sales-autopilot";

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
});
