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

export function GoogleTagPageView({ ga4Id }: { ga4Id: string }) {
  const pathname = usePathname();
  const didMountRef = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      !isAnalyticsAllowed() ||
      !isPublicTrackingPath(pathname) ||
      !/^G-[A-Z0-9]+$/u.test(ga4Id) ||
      ga4Id === "G-E2ETEST"
    )
      return;
    if (typeof window.gtag !== "function") return;
    if (!didMountRef.current) {
      didMountRef.current = true;
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
