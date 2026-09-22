"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  COOKIE_CONSENT_EVENT,
  COOKIE_SETTINGS_EVENT,
  getCookiePreferences,
  hasPrivacySignal,
  setCookiePreferences,
} from "@/lib/cookie-consent";

const choiceButtonClass =
  "min-h-11 rounded-lg border border-primary-800 bg-white px-3 py-2 text-sm font-semibold text-primary-900 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700 disabled:cursor-not-allowed disabled:opacity-50";

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [advertising, setAdvertising] = useState(false);
  const [privacySignal, setPrivacySignal] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const readPreferences = () => {
      const preferences = getCookiePreferences();
      const signal = hasPrivacySignal();
      setPrivacySignal(signal);
      setAnalytics(!signal && (preferences?.analytics ?? false));
      setAdvertising(!signal && (preferences?.advertising ?? false));
      return preferences;
    };
    setVisible(readPreferences() === null);

    const openSettings = () => {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      readPreferences();
      setCustomizing(true);
      setVisible(true);
    };
    const onConsentChange = () => {
      readPreferences();
      setVisible(false);
    };
    window.addEventListener(COOKIE_SETTINGS_EVENT, openSettings);
    window.addEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
    return () => {
      window.removeEventListener(COOKIE_SETTINGS_EVENT, openSettings);
      window.removeEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
    };
  }, []);

  useEffect(() => {
    if (visible && customizing) headingRef.current?.focus();
  }, [visible, customizing]);

  const close = () => {
    setVisible(false);
    setCustomizing(false);
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    returnFocusRef.current = null;
  };

  const save = (allowAnalytics: boolean, allowAdvertising: boolean) => {
    setCookiePreferences({
      analytics: allowAnalytics,
      advertising: allowAdvertising,
    });
    close();
  };

  if (!visible) return null;

  return (
    <section
      aria-labelledby="cookie-preferences-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+5.75rem)] z-[70] max-h-[65dvh] overflow-y-auto overscroll-contain rounded-2xl border border-neutral-300 bg-white p-4 text-neutral-900 shadow-xl sm:p-5 md:inset-x-auto md:bottom-6 md:left-6 md:w-[min(40rem,calc(100vw-3rem))] md:max-h-[80dvh]"
    >
      <div className="flex items-start justify-between gap-4">
        <h2
          ref={headingRef}
          id="cookie-preferences-heading"
          tabIndex={-1}
          className="pt-2 text-lg font-semibold text-primary-900 focus:outline-none"
        >
          {customizing ? "Cookie settings" : "Your cookie choices"}
        </h2>
        <button
          type="button"
          aria-label="Close cookie notice"
          onClick={close}
          className="min-h-11 rounded-md px-2 text-sm text-neutral-700 underline underline-offset-4 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-700"
        >
          Close
        </button>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-neutral-700">
        {customizing
          ? "Choose which optional cookies and browser storage to allow. You can change your choice anytime. "
          : "We use necessary cookies to run this site. Optional cookies and browser storage help Stonegate, Google, Meta, and OpenAI understand visits and measure or personalize ads. They stay off until you choose. Change your choice anytime in Cookie settings. "}
        <Link
          href="/privacy#cookies"
          prefetch={false}
          className="rounded-sm font-medium text-primary-800 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-700"
        >
          Cookie policy
        </Link>
        .
      </p>
      {privacySignal ? (
        <p
          id="cookie-privacy-signal"
          className="mt-3 rounded-lg bg-neutral-100 p-3 text-sm text-neutral-800"
        >
          Your browser sends a Global Privacy Control or Do Not Track signal.
          Analytics and advertising are off while that signal is enabled.
        </p>
      ) : null}

      {customizing ? (
        <>
          <fieldset
            className="mt-4 space-y-3"
            aria-describedby={
              privacySignal ? "cookie-privacy-signal" : undefined
            }
          >
            <legend className="sr-only">Cookie categories</legend>
            <div className="rounded-lg border border-neutral-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Necessary</span>
                <span className="text-xs font-medium text-neutral-600">
                  Always on
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-600">
                Remember your cookie choice and support essential features such
                as security and sign-in.
              </p>
            </div>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 has-[:disabled]:cursor-default">
              <input
                type="checkbox"
                checked={analytics}
                disabled={privacySignal}
                onChange={(event) => setAnalytics(event.target.checked)}
                className="mt-1 h-5 w-5 shrink-0 accent-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700"
              />
              <span>
                <span className="block text-sm font-semibold">Analytics</span>
                <span className="mt-1 block text-sm text-neutral-600">
                  Help Stonegate understand website visits, page performance,
                  and how forms are used.
                </span>
              </span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 has-[:disabled]:cursor-default">
              <input
                type="checkbox"
                checked={advertising}
                disabled={privacySignal}
                onChange={(event) => setAdvertising(event.target.checked)}
                className="mt-1 h-5 w-5 shrink-0 accent-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700"
              />
              <span>
                <span className="block text-sm font-semibold">Advertising</span>
                <span className="mt-1 block text-sm text-neutral-600">
                  Let Google, Meta, OpenAI, and Stonegate connect ad visits with
                  inquiries and bookings to measure and personalize advertising.
                </span>
              </span>
            </label>
          </fieldset>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => save(analytics, advertising)}
              className={choiceButtonClass}
            >
              Save preferences
            </button>
            <button
              type="button"
              onClick={() => save(false, false)}
              className={choiceButtonClass}
            >
              Reject optional cookies
            </button>
          </div>
        </>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={privacySignal}
            onClick={() => save(true, true)}
            className={choiceButtonClass}
          >
            Accept optional cookies
          </button>
          <button
            type="button"
            onClick={() => save(false, false)}
            className={choiceButtonClass}
          >
            Reject optional cookies
          </button>
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className={choiceButtonClass}
          >
            Customize
          </button>
        </div>
      )}
    </section>
  );
}
