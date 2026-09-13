/** Presentation-only fallback; never changes booking or payment policy. */
export function isMobileBookingCardsV2Enabled(): boolean {
  return (
    process.env["MOBILE_BOOKING_CARDS_V2_ENABLED"]?.trim().toLowerCase() !==
    "false"
  );
}
