import { GoogleTag } from "@/components/GoogleTag";
import { OpenAiAdsPixel } from "@/components/OpenAiAdsPixel";

/**
 * Marketing tags belong only on public acquisition and customer hand-off
 * surfaces. Authenticated CRM, mobile, crew, admin, and partner routes must not
 * inherit them from the root layout.
 */
export function PublicMarketingTags() {
  const ga4Id = process.env["NEXT_PUBLIC_GA4_ID"] ?? null;
  const googleAdsTagId = process.env["NEXT_PUBLIC_GOOGLE_ADS_TAG_ID"] ?? null;

  return (
    <>
      <GoogleTag ga4Id={ga4Id} googleAdsTagId={googleAdsTagId} />
      <OpenAiAdsPixel
        pixelId={process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"] ?? null}
      />
    </>
  );
}
