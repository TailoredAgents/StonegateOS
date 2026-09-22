"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  initializeOpenAiAdsPixel,
  OPENAI_ADS_CONSENT_EVENT,
  suspendOpenAiAdsPixel,
  trackOpenAiAdsPageView,
  trackOpenAiAdsPhoneClick,
} from "@/lib/openai-ads";

export function OpenAiAdsPixel({ pixelId }: { pixelId: string | null }) {
  const pathname = usePathname();
  useEffect(() => {
    if (!pixelId) return;
    const start = () => {
      if (initializeOpenAiAdsPixel(pixelId)) trackOpenAiAdsPageView();
    };
    const onClick = (event: MouseEvent) => {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (link?.getAttribute("href")?.trim().toLowerCase().startsWith("tel:"))
        trackOpenAiAdsPhoneClick();
    };
    start();
    window.addEventListener(OPENAI_ADS_CONSENT_EVENT, start);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(OPENAI_ADS_CONSENT_EVENT, start);
      document.removeEventListener("click", onClick, true);
      suspendOpenAiAdsPixel();
    };
  }, [pathname, pixelId]);
  return null;
}
