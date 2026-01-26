"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

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
    if (typeof window.gtag !== "function") return;
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    window.gtag("config", ga4Id, { page_path: pathname });
  }, [ga4Id, pathname]);

  return null;
}
