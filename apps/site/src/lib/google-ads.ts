declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
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

    window.dataLayer = window.dataLayer || [];
    if (Array.isArray(window.dataLayer)) {
      // Mirror the gtag() stub behavior: it pushes the `arguments` array into dataLayer.
      window.dataLayer.push(["event", "conversion", { send_to: normalized, ...(params ?? {}) }]);
    }
  } catch (error) {
    console.warn("Google Ads conversion tracking failed", error);
  }
}
