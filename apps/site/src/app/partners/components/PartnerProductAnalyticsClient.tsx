"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { flushWebAnalytics, trackWebEvent } from "@/lib/web-analytics";

const SAFE_ACTION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const OPAQUE_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{32,})$/u;
type ReportedWebVital = Readonly<{ name: string; value: number }>;

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

  const reportWebVital = React.useCallback((metric: ReportedWebVital) => {
    if (
      metric.name !== "LCP" &&
      metric.name !== "INP" &&
      metric.name !== "CLS"
    ) {
      return;
    }
    if (!Number.isFinite(metric.value)) return;
    trackWebEvent({
      event: "web_vital",
      path: pathRef.current,
      key: metric.name,
      value: metric.value,
      privacyMode: "product",
    });
    // Web-vital callbacks can finalize as a page is being hidden. Flush the
    // newly queued metric immediately so it is not stranded behind a timer.
    flushWebAnalytics();
  }, []);
  useReportWebVitals(reportWebVital);

  React.useEffect(() => {
    trackWebEvent({
      event: "partner_page_view",
      path,
      privacyMode: "product",
    });
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushWebAnalytics();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flushWebAnalytics);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flushWebAnalytics);
      flushWebAnalytics();
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
