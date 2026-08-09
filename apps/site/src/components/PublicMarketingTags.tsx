import { GoogleTag } from "@/components/GoogleTag";

/**
 * Marketing tags belong only on public acquisition and customer hand-off
 * surfaces. Authenticated CRM, mobile, crew, admin, and partner routes must not
 * inherit them from the root layout.
 */
export function PublicMarketingTags() {
  const ga4Id = process.env["NEXT_PUBLIC_GA4_ID"] ?? null;
  const googleAdsTagId =
    process.env["NEXT_PUBLIC_GOOGLE_ADS_TAG_ID"] ?? null;

  return <GoogleTag ga4Id={ga4Id} googleAdsTagId={googleAdsTagId} />;
}
