declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export function trackGoogleAdsConversion(sendTo: string, params?: Record<string, unknown>) {
  const normalized = sendTo.trim();
  if (!normalized) return;

  try {
    if (typeof window === "undefined") return;
    if (typeof window.gtag === "function") {
      window.gtag("event", "conversion", { send_to: normalized, ...(params ?? {}) });
      return;
    }

    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: "google_ads_conversion", send_to: normalized, ...(params ?? {}) });
    }
  } catch (error) {
    console.warn("Google Ads conversion tracking failed", error);
  }
}

