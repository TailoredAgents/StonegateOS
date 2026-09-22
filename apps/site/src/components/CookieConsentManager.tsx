"use client";

import { useEffect, useState } from "react";
import {
  clearDisallowedCookieData,
  COOKIE_CONSENT_COOKIE,
  COOKIE_CONSENT_EVENT,
  COOKIE_CONSENT_MAX_AGE,
  COOKIE_CONSENT_STORAGE_KEY,
  isAdvertisingAllowed,
  isAnalyticsAllowed,
  parseCookiePreferences,
} from "@/lib/cookie-consent";
import { setOpenAiAdsMeasurementConsent } from "@/lib/openai-ads";
import { readConsentedUtm } from "@/lib/use-utm";
import { CookieConsentBanner } from "./CookieConsentBanner";
import { GoogleTag } from "./GoogleTag";
import { MetaPixel } from "./MetaPixel";
import { OpenAiAdsPixel } from "./OpenAiAdsPixel";

export function CookieConsentManager({
  ga4Id,
  googleAdsTagId,
  metaPixelId,
  openAiPixelId,
}: {
  ga4Id: string | null;
  googleAdsTagId: string | null;
  metaPixelId: string | null;
  openAiPixelId: string | null;
}) {
  // Never emit third-party scripts in server HTML or before reading the browser's choice.
  const [allowed, setAllowed] = useState({
    analytics: false,
    advertising: false,
  });
  useEffect(() => {
    let previous: { analytics: boolean; advertising: boolean } | null = null;
    const sync = () => {
      const analytics = isAnalyticsAllowed();
      const advertising = isAdvertisingAllowed();
      if (
        previous?.analytics === analytics &&
        previous.advertising === advertising
      )
        return;
      window.gtag?.("consent", "update", {
        analytics_storage: analytics ? "granted" : "denied",
        ad_storage: advertising ? "granted" : "denied",
        ad_user_data: advertising ? "granted" : "denied",
        ad_personalization: advertising ? "granted" : "denied",
      });
      window.fbq?.("consent", advertising ? "grant" : "revoke");
      if (!advertising) window.gtag?.("set", "user_data", {});
      // Revoke linked server measurement before removing the browser's attribution data.
      if (openAiPixelId && previous?.advertising !== advertising)
        setOpenAiAdsMeasurementConsent(advertising);
      if (advertising) readConsentedUtm();
      clearDisallowedCookieData();
      previous = { analytics, advertising };
      setAllowed((previous) =>
        previous.analytics === analytics && previous.advertising === advertising
          ? previous
          : { analytics, advertising },
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === COOKIE_CONSENT_STORAGE_KEY || event.key === null) {
        // Safari can deliver storage events before refreshing another tab's
        // cookie cache. Apply the same versioned choice before reconciling SDKs.
        let latest = event.newValue;
        try {
          latest = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
        } catch {
          /* Use the event value when storage access is restricted. */
        }
        const preference = parseCookiePreferences(latest);
        const remaining = preference
          ? Math.max(
              0,
              Math.floor(
                COOKIE_CONSENT_MAX_AGE -
                  (Date.now() - preference.updatedAt) / 1000,
              ),
            )
          : 0;
        try {
          document.cookie = `${COOKIE_CONSENT_COOKIE}=${preference ? encodeURIComponent(JSON.stringify(preference)) : ""}; Path=/; SameSite=Lax; Max-Age=${remaining}${window.location.protocol === "https:" ? "; Secure" : ""}`;
        } catch {
          // Restricted cookies continue to fail closed through the consent reader.
        }
        window.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    sync();
    window.addEventListener(COOKIE_CONSENT_EVENT, sync);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_EVENT, sync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisibility);
      // Do not let SDKs carried through SPA navigation keep measuring private surfaces.
      window.fbq?.("consent", "revoke");
      window.gtag?.("consent", "update", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    };
  }, [openAiPixelId]);

  return (
    <>
      <CookieConsentBanner />
      {(allowed.analytics || allowed.advertising) && (
        <GoogleTag
          ga4Id={allowed.analytics ? ga4Id : null}
          googleAdsTagId={allowed.advertising ? googleAdsTagId : null}
        />
      )}
      {allowed.advertising && (
        <>
          <MetaPixel pixelId={metaPixelId} />
          <OpenAiAdsPixel pixelId={openAiPixelId} />
        </>
      )}
    </>
  );
}
