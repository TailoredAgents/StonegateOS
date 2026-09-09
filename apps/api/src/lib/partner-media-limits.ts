export const PARTNER_IMAGE_LIMIT = 40;
export const PARTNER_DOCUMENT_LIMIT = 10;
/** Documents have their own allowance and cannot consume the promised 40-photo allowance. */
export function partnerMediaCountsAllowed(
  images: number,
  documents: number,
): boolean {
  return (
    Number.isSafeInteger(images) &&
    Number.isSafeInteger(documents) &&
    images >= 0 &&
    documents >= 0 &&
    images <= PARTNER_IMAGE_LIMIT &&
    documents <= PARTNER_DOCUMENT_LIMIT
  );
}
