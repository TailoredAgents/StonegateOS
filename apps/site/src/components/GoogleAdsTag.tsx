import Script from "next/script";

export function GoogleAdsTag({ tagId }: { tagId: string | null }) {
  if (!tagId) return null;
  const sanitized = tagId.trim();
  if (!sanitized) return null;

  return (
    <>
      <Script id="google-ads-stub" strategy="beforeInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${sanitized}');`}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(sanitized)}`}
        strategy="lazyOnload"
      />
    </>
  );
}

