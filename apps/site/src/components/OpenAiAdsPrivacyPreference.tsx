"use client";

import { useEffect, useState } from "react";
import {
  hasOpenAiAdsPrivacySignal,
  isOpenAiAdsMeasurementAllowed,
  OPENAI_ADS_CONSENT_EVENT,
  setOpenAiAdsMeasurementConsent,
} from "@/lib/openai-ads";

export function OpenAiAdsPrivacyPreference() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [privacySignal, setPrivacySignal] = useState(false);
  useEffect(() => {
    const update = () => {
      setAllowed(isOpenAiAdsMeasurementAllowed());
      setPrivacySignal(hasOpenAiAdsPrivacySignal());
    };
    update();
    window.addEventListener(OPENAI_ADS_CONSENT_EVENT, update);
    return () => window.removeEventListener(OPENAI_ADS_CONSENT_EVENT, update);
  }, []);
  if (!process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"]?.trim()) return null;
  return (
    <section
      aria-labelledby="chatgpt-ad-preference"
      className="not-prose my-6 rounded-xl border border-neutral-300 bg-white p-5"
    >
      <h3 id="chatgpt-ad-preference" className="font-semibold text-neutral-900">
        ChatGPT ad measurement
      </h3>
      <p className="mt-2 text-sm text-neutral-700" aria-live="polite">
        {allowed === null
          ? "Checking your preference…"
          : privacySignal
            ? "Off. Your browser sends a Do Not Track or Global Privacy Control signal."
            : allowed
              ? "On for this browser. You can turn off future ChatGPT ad measurement below."
              : "Off for this browser."}
      </p>
      <button
        type="button"
        disabled={allowed === null || privacySignal}
        onClick={() => setOpenAiAdsMeasurementConsent(!allowed)}
        className="mt-3 min-h-11 rounded-md border border-neutral-400 px-4 py-2 text-sm font-semibold text-neutral-900 disabled:opacity-50"
      >
        {allowed
          ? "Turn off ChatGPT ad measurement"
          : "Allow ChatGPT ad measurement"}
      </button>
      <p className="mt-2 text-xs text-neutral-600">
        This preference applies to future measurement from this browser and
        linked service requests. Contact us about an earlier measurement record.
      </p>
    </section>
  );
}
