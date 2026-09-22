"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  isAdvertisingAllowed,
  isPublicTrackingPath,
} from "@/lib/cookie-consent";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

// Public route-group layouts remount without re-running the SDK init script.
// Write only in the client effect so this state cannot cross SSR requests.
let lastPathname: string | undefined;

export function MetaPixelPageView() {
  const pathname = usePathname();

  React.useEffect(() => {
    if (typeof window === "undefined" || !pathname) return;
    if (!isAdvertisingAllowed() || !isPublicTrackingPath(pathname)) return;
    const previous = lastPathname;
    lastPathname = pathname;
    // SDK init owns the first view; repeated effects/remounts add no duplicate.
    if (previous === undefined || previous === pathname) return;
    if (typeof window.fbq !== "function") {
      return;
    }
    window.fbq("track", "PageView");
  }, [pathname]);

  return null;
}
