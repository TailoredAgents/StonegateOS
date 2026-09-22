"use client";

import { openCookieSettings } from "@/lib/cookie-consent";

export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.focus();
        openCookieSettings();
      }}
      className={
        className ??
        "inline-flex min-h-11 items-center rounded-sm hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700"
      }
    >
      Cookie settings
    </button>
  );
}
