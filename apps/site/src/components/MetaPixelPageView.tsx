"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
  }
}

export function MetaPixelPageView() {
  const pathname = usePathname();
  const didMountRef = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.fbq !== "function") return;
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    window.fbq("track", "PageView");
  }, [pathname]);

  return null;
}
