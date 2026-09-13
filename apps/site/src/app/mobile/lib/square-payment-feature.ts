/** Temporary mobile visibility switch; existing payment processing stays intact. */
export function isMobileSquarePaymentsEnabled(): boolean {
  return (
    process.env["MOBILE_SQUARE_PAYMENTS_ENABLED"]?.trim().toLowerCase() ===
    "true"
  );
}
