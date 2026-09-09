"use client";

import { useEffect, useRef, useState } from "react";

/** One bounded polling controller for private, resource-keyed portal views. */
export function usePartnerLiveRefresh(
  resourceKey: string,
  refresh: (signal: AbortSignal) => Promise<boolean>,
  enabled = true,
) {
  const callback = useRef(refresh);
  callback.current = refresh;
  const [stale, setStale] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setStale(false);
    setLastUpdatedAt(null);
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed)
        timer = setTimeout(
          () => void run(),
          Math.min(60_000, 15_000 * 2 ** failures),
        );
    };
    const run = async () => {
      if (disposed || running) return;
      if (document.visibilityState === "hidden" || !navigator.onLine) {
        if (!navigator.onLine) setStale(true);
        schedule();
        return;
      }
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8_000);
      try {
        const ok = await callback.current(controller.signal);
        if (disposed) return;
        failures = ok ? 0 : Math.min(failures + 1, 2);
        setStale(!ok);
        if (ok) setLastUpdatedAt(Date.now());
      } catch {
        if (!disposed) {
          failures = Math.min(failures + 1, 2);
          setStale(true);
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        schedule();
      }
    };
    const resume = () => void run();
    const offline = () => {
      setStale(true);
      controller?.abort();
    };
    schedule();
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [resourceKey, enabled]);
  return { stale, lastUpdatedAt };
}
