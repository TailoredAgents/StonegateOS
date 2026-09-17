"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

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
    const previous = lastPathByTag.get(ga4Id);
    lastPathByTag.set(ga4Id, pathname);
    // Initial config owns the first view, even if its script loads after us.
    if (previous === undefined || previous === pathname) return;
    if (typeof window.gtag !== "function") {
      return;
    }

    window.gtag("config", ga4Id, { page_path: pathname });
  }, [ga4Id, pathname]);

  return null;
}
