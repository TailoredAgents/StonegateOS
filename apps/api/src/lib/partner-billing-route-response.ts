export const PARTNER_BILLING_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

/** Applies the financial-route cache policy to delegated boundary responses. */
export function withPartnerBillingNoStore(response: Response): Response {
  for (const [name, value] of Object.entries(PARTNER_BILLING_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
