"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  isAdvertisingAllowed,
  isPublicTrackingPath,
} from "@/lib/cookie-consent";

type MetaQueue = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: (...args: unknown[]) => void;
  loaded: boolean;
  version: string;
};
const initializedPixels = new Set<string>();

export function MetaPixel({ pixelId }: { pixelId: string | null }) {
  const pathname = usePathname();
  useEffect(() => {
    const id = pixelId?.trim();
    if (
      !id ||
      !/^\d{5,32}$/u.test(id) ||
      !isAdvertisingAllowed() ||
      !isPublicTrackingPath(window.location.pathname)
    )
      return;
    if (!window.fbq) {
      const queue = ((...args: unknown[]) => {
        if (queue.callMethod) queue.callMethod(...args);
        else queue.queue.push(args);
      }) as MetaQueue;
      queue.queue = [];
      queue.push = queue;
      queue.loaded = true;
      queue.version = "2.0";
      window.fbq = queue;
      (window as Window & { _fbq?: MetaQueue })._fbq = queue;
    }
    window.fbq("consent", "grant");
    if (!initializedPixels.has(id)) {
      window.fbq("init", id);
      initializedPixels.add(id);
    }
    window.fbq("track", "PageView");
    if (!document.getElementById("stonegate-meta-pixel")) {
      const script = document.createElement("script");
      script.id = "stonegate-meta-pixel";
      script.async = true;
      script.src = "https://connect.facebook.net/en_US/fbevents.js";
      document.head.appendChild(script);
    }
    return () => {
      window.fbq?.("consent", "revoke");
    };
  }, [pixelId, pathname]);
  // JavaScript-disabled visits cannot grant optional-cookie consent.
  return null;
}
