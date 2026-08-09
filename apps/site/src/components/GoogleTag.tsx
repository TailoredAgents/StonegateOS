import Script from "next/script";
import { GoogleTagPageView } from "@/components/GoogleTagPageView";

const AUDIT_SENTINEL_TAG_IDS = new Set(["G-E2ETEST", "AW-E2ETEST"]);

function normalizeTagId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || AUDIT_SENTINEL_TAG_IDS.has(normalized)) return null;
  return normalized;
}

export function GoogleTag({
  ga4Id,
  googleAdsTagId,
}: {
  ga4Id: string | null;
  googleAdsTagId: string | null;
}) {
  const normalizedGa4Id = normalizeTagId(ga4Id);
  const normalizedGoogleAdsTagId = normalizeTagId(googleAdsTagId);
  // Prefer loading gtag.js with the Google Ads tag ID when present so Google Ads tag
  // detection tools can reliably see it (config still includes both IDs).
  const primaryId = normalizedGoogleAdsTagId ?? normalizedGa4Id;

  if (!primaryId) return null;

  const configCalls = [
    normalizedGa4Id ? `gtag('config', '${normalizedGa4Id}');` : null,
    normalizedGoogleAdsTagId
      ? `gtag('config', '${normalizedGoogleAdsTagId}');`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <Script id="google-tag-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
${configCalls}`}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primaryId)}`}
        strategy="afterInteractive"
        async
      />
      {normalizedGa4Id ? <GoogleTagPageView ga4Id={normalizedGa4Id} /> : null}
    </>
  );
}
