import { CookieConsentManager } from "@/components/CookieConsentManager";

/**
 * Marketing tags belong only on public acquisition pages. Private quote and
 * scheduling handoffs, CRM, mobile, crew, admin, and partner routes must not
 * inherit them from the root layout.
 */
export function PublicMarketingTags({
  includeMetaPixel = false,
}: { includeMetaPixel?: boolean } = {}) {
  const ga4Id = process.env["NEXT_PUBLIC_GA4_ID"] ?? null;
  const googleAdsTagId = process.env["NEXT_PUBLIC_GOOGLE_ADS_TAG_ID"] ?? null;

  return (
    <CookieConsentManager
      ga4Id={ga4Id}
      googleAdsTagId={googleAdsTagId}
      metaPixelId={
        includeMetaPixel
          ? (process.env["NEXT_PUBLIC_META_PIXEL_ID"] ?? null)
          : null
      }
      openAiPixelId={process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"] ?? null}
    />
  );
}
