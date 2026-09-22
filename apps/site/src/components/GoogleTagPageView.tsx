"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  isAdvertisingAllowed,
  isAnalyticsAllowed,
  isPublicTrackingPath,
} from "@/lib/cookie-consent";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// Public route-group layouts remount while Next keeps the SDK init script.
// Keep this browser-only navigation history across component instances.
const lastPathByTag = new Map<string, string>();

export function GoogleTagPageView({ ga4Id }: { ga4Id: string }) {
  const pathname = usePathname();

  React.useEffect(() => {
    if (typeof window === "undefined" || !pathname) return;
    if (
      !isAnalyticsAllowed() ||
      !isPublicTrackingPath(pathname) ||
      !/^G-[A-Z0-9]+$/u.test(ga4Id) ||
      ga4Id === "G-E2ETEST"
    )
      return;
    const previous = lastPathByTag.get(ga4Id);
    lastPathByTag.set(ga4Id, pathname);
    // Initial config owns the first view, even if its script loads after us.
    if (previous === undefined || previous === pathname) return;
    if (typeof window.gtag !== "function") {
      return;
    }

    window.gtag("config", ga4Id, {
      page_path: pathname,
      page_location: isAdvertisingAllowed()
        ? window.location.href
        : window.location.origin + window.location.pathname,
      page_referrer: "",
      allow_google_signals: isAdvertisingAllowed(),
      allow_ad_personalization_signals: isAdvertisingAllowed(),
    });
  }, [ga4Id, pathname]);

  return null;
}
