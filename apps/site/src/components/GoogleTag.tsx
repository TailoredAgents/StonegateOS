"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  isAdvertisingAllowed,
  isAnalyticsAllowed,
  isPublicTrackingPath,
} from "@/lib/cookie-consent";

const AUDIT_SENTINEL_TAG_IDS = new Set(["G-E2ETEST", "AW-E2ETEST"]);
let consentInitialized = false;

function normalizeTagId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (
    !normalized ||
    !/^(?:G|AW)-[A-Z0-9]+$/u.test(normalized) ||
    AUDIT_SENTINEL_TAG_IDS.has(normalized)
  )
    return null;
  return normalized;
}

export function GoogleTag({
  ga4Id,
  googleAdsTagId,
}: {
  ga4Id: string | null;
  googleAdsTagId: string | null;
}) {
  const pathname = usePathname();
  const ga = normalizeTagId(ga4Id);
  const ads = normalizeTagId(googleAdsTagId);
  useEffect(() => {
    if (!isPublicTrackingPath(window.location.pathname)) return;
    const analytics = isAnalyticsAllowed();
    const advertising = isAdvertisingAllowed();
    const gaId = analytics ? ga : null;
    const adsId = advertising ? ads : null;
    const primaryId = adsId ?? gaId;
    if (!primaryId) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        // eslint-disable-next-line prefer-rest-params -- Google's documented gtag queue uses an arguments object.
        window.dataLayer?.push(arguments);
      };
    if (!consentInitialized) {
      window.gtag("consent", "default", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
      consentInitialized = true;
      window.gtag("js", new Date());
    }
    window.gtag("consent", "update", {
      analytics_storage: analytics ? "granted" : "denied",
      ad_storage: advertising ? "granted" : "denied",
      ad_user_data: advertising ? "granted" : "denied",
      ad_personalization: advertising ? "granted" : "denied",
    });
    window.gtag("set", "ads_data_redaction", !advertising);
    if (gaId) {
      (window as unknown as Record<string, unknown>)[`ga-disable-${gaId}`] =
        false;
      let referrer = "";
      try {
        referrer = document.referrer ? new URL(document.referrer).origin : "";
      } catch {
        /* Invalid referrer. */
      }
      // Analytics-only permission must not forward ad-click identifiers or private query strings.
      window.gtag("config", gaId, {
        page_path: pathname,
        page_location: advertising
          ? window.location.href
          : window.location.origin + window.location.pathname,
        page_referrer: advertising ? document.referrer : referrer,
        allow_google_signals: advertising,
        allow_ad_personalization_signals: advertising,
      });
    }
    if (adsId) window.gtag("config", adsId);
    if (!document.getElementById("stonegate-google-tag")) {
      const script = document.createElement("script");
      script.id = "stonegate-google-tag";
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primaryId)}`;
      document.head.appendChild(script);
    }
    return () => {
      if (gaId)
        (window as unknown as Record<string, unknown>)[`ga-disable-${gaId}`] =
          true;
    };
  }, [ga, ads, pathname]);
  return null;
}
