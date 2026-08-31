"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { flushWebAnalytics, trackWebEvent } from "@/lib/web-analytics";

type BufferedObserverInit = PerformanceObserverInit & {
  type: string;
  buffered: boolean;
  durationThreshold?: number;
};

type LayoutShiftEntry = PerformanceEntry & {
  hadRecentInput?: boolean;
  value?: number;
};

const SAFE_ACTION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const OPAQUE_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{32,})$/u;

export function sanitizePartnerAnalyticsPath(pathname: string): string {
  const path = pathname.split("?", 1)[0] || "/partners";
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "partners") return "/partners";

  return `/${segments
    .map((segment, index) => {
      const prior = segments[index - 1];
      if (prior === "bookings") return "[job]";
      if (prior === "proof") return "[share]";
      return OPAQUE_SEGMENT.test(segment) ? "[opaque]" : segment.slice(0, 64);
    })
    .join("/")}`;
}

function safeActionKey(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return SAFE_ACTION_KEY.test(normalized) ? normalized : null;
}

function reportVital(
  path: string,
  metric: "LCP" | "INP" | "CLS",
  value: number,
): void {
  const rating =
    metric === "LCP"
      ? value <= 2500
        ? "good"
        : value <= 4000
          ? "needs_improvement"
          : "poor"
      : metric === "INP"
        ? value <= 200
          ? "good"
          : value <= 500
            ? "needs_improvement"
            : "poor"
        : value <= 0.1
          ? "good"
          : value <= 0.25
            ? "needs_improvement"
            : "poor";

  trackWebEvent({
    event: "web_vital",
    path,
    key: metric,
    value,
    meta: { product: "partner_portal", rating },
    privacyMode: "product",
  });
}

function observePartnerVitals(path: string): () => void {
  if (typeof PerformanceObserver !== "function") return () => undefined;

  let lcp = 0;
  let inp = 0;
  let cls = 0;
  const observers: PerformanceObserver[] = [];

  const observe = (
    type: string,
    callback: (entries: PerformanceEntry[]) => void,
    extra?: Partial<BufferedObserverInit>,
  ) => {
    try {
      const observer = new PerformanceObserver((list) =>
        callback(list.getEntries()),
      );
      observer.observe({
        type,
        buffered: true,
        ...extra,
      } as BufferedObserverInit);
      observers.push(observer);
    } catch {
      // Unsupported metrics remain absent rather than being fabricated.
    }
  };

  observe("largest-contentful-paint", (entries) => {
    const latest = entries.at(-1);
    if (latest && Number.isFinite(latest.startTime)) lcp = latest.startTime;
  });
  observe(
    "event",
    (entries) => {
      for (const entry of entries) {
        if (Number.isFinite(entry.duration))
          inp = Math.max(inp, entry.duration);
      }
    },
    { durationThreshold: 40 },
  );
  observe("layout-shift", (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (!entry.hadRecentInput && Number.isFinite(entry.value)) {
        cls += entry.value ?? 0;
      }
    }
  });

  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    for (const observer of observers) observer.disconnect();
    if (lcp > 0) reportVital(path, "LCP", Math.round(lcp));
    if (inp > 0) reportVital(path, "INP", Math.round(inp));
    reportVital(path, "CLS", Number(cls.toFixed(4)));
    flushWebAnalytics();
  };
}

/**
 * First-party product telemetry for portal reliability and funnel health.
 * It intentionally omits campaign/referrer/location data, scrubs opaque URL
 * segments, and accepts only explicitly marked, allowlisted interaction keys.
 */
export function PartnerProductAnalyticsClient(): null {
  const rawPath = usePathname() ?? "/partners";
  const path = sanitizePartnerAnalyticsPath(rawPath);
  const pathRef = React.useRef(path);
  pathRef.current = path;

  React.useEffect(() => {
    trackWebEvent({
      event: "partner_page_view",
      path,
      privacyMode: "product",
    });
    const report = observePartnerVitals(path);
    const onHidden = () => {
      if (document.visibilityState === "hidden") report();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", report, { once: true });
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", report);
      report();
    };
  }, [path]);

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const marked = target.closest<HTMLElement>("[data-partner-analytics]");
      if (!marked) return;
      const key = safeActionKey(marked.dataset["partnerAnalytics"] ?? null);
      if (!key) return;
      trackWebEvent({
        event: "partner_action",
        path: pathRef.current,
        key,
        privacyMode: "product",
      });
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const key = safeActionKey(form.dataset["partnerAnalytics"] ?? null);
      if (!key) return;
      trackWebEvent({
        event: "partner_form_submit",
        path: pathRef.current,
        key,
        privacyMode: "product",
      });
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);

  return null;
}
