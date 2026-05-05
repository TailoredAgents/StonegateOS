"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { trackGoogleAdsConversion } from "@/lib/google-ads";
import {
  ensureVisitStarted,
  flushWebAnalytics,
  trackWebEvent,
} from "@/lib/web-analytics";

const GOOGLE_ADS_CALL_SEND_TO =
  process.env["NEXT_PUBLIC_GOOGLE_ADS_CALL_SEND_TO"] ?? "";

type BufferedPerformanceObserverInit = PerformanceObserverInit & {
  type: string;
  buffered: boolean;
};

type LayoutShiftPerformanceEntry = PerformanceEntry & {
  hadRecentInput?: boolean;
  value?: number;
};

function hasClosest(target: EventTarget | null): target is Element {
  return target instanceof Element && typeof target.closest === "function";
}

function resolveTelClick(
  target: EventTarget | null,
): { href: string; cta: string | null } | null {
  if (!hasClosest(target)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const href = anchor.getAttribute("href") ?? "";
  if (!href) return null;
  if (href.trim().toLowerCase().startsWith("tel:")) {
    return { href: href.trim(), cta: anchor.getAttribute("data-cta") };
  }
  return null;
}

function computeVitals(pathname: string): void {
  if (typeof window === "undefined") return;
  if (typeof PerformanceObserver !== "function") return;

  let lcp = 0;
  let cls = 0;
  let lcpReported = false;
  let clsReported = false;

  const report = () => {
    if (!lcpReported && lcp > 0) {
      const rating =
        lcp <= 2500 ? "good" : lcp <= 4000 ? "needs_improvement" : "poor";
      trackWebEvent({
        event: "web_vital",
        path: pathname,
        key: "LCP",
        value: lcp,
        meta: { rating },
      });
      lcpReported = true;
    }
    if (!clsReported && cls >= 0) {
      const rating =
        cls <= 0.1 ? "good" : cls <= 0.25 ? "needs_improvement" : "poor";
      trackWebEvent({
        event: "web_vital",
        path: pathname,
        key: "CLS",
        value: Number(cls.toFixed(4)),
        meta: { rating },
      });
      clsReported = true;
    }
  };

  const lcpObserver = new PerformanceObserver((entryList) => {
    const entries = entryList.getEntries();
    const last = entries[entries.length - 1];
    const value = last ? last.startTime : 0;
    if (Number.isFinite(value) && value > 0) lcp = value;
  });
  const clsObserver = new PerformanceObserver((entryList) => {
    for (const entry of entryList.getEntries() as LayoutShiftPerformanceEntry[]) {
      if (!entry) continue;
      if (entry.hadRecentInput) continue;
      const value = typeof entry.value === "number" ? entry.value : 0;
      if (Number.isFinite(value) && value > 0) cls += value;
    }
  });

  try {
    lcpObserver.observe({
      type: "largest-contentful-paint",
      buffered: true,
    } as BufferedPerformanceObserverInit);
  } catch {
    // ignore
  }
  try {
    clsObserver.observe({
      type: "layout-shift",
      buffered: true,
    } as BufferedPerformanceObserverInit);
  } catch {
    // ignore
  }

  const onPageHide = () => {
    try {
      lcpObserver.disconnect();
      clsObserver.disconnect();
    } catch {
      // ignore
    }
    report();
    flushWebAnalytics();
  };

  window.addEventListener("pagehide", onPageHide, { once: true });
}

export function WebAnalyticsClient(): React.ReactElement | null {
  const pathname = usePathname() ?? "/";
  const pathRef = React.useRef(pathname);
  pathRef.current = pathname;

  React.useEffect(() => {
    ensureVisitStarted(pathname);
    trackWebEvent({ event: "page_view", path: pathname });
    computeVitals(pathname);
  }, [pathname]);

  React.useEffect(() => {
    const onClickCapture = (event: MouseEvent) => {
      const tel = resolveTelClick(event.target);
      if (!tel) return;
      const path = pathRef.current;
      trackWebEvent({
        event: "cta_click",
        path,
        key: "call",
        meta: {
          href: tel.href.slice(0, 40),
          ...(tel.cta ? { cta: tel.cta } : {}),
        },
      });
      if (path === "/book" && GOOGLE_ADS_CALL_SEND_TO) {
        trackGoogleAdsConversion(GOOGLE_ADS_CALL_SEND_TO, {
          value: 1,
          currency: "USD",
          event_category: "phone",
          event_label: tel.cta ?? "call",
          page_path: path,
        });
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushWebAnalytics();
      }
    };

    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushWebAnalytics);

    return () => {
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushWebAnalytics);
    };
  }, []);

  return null;
}
