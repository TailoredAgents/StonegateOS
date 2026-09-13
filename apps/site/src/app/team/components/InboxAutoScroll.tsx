"use client";

import { useEffect, useRef } from "react";

type InboxAutoScrollProps = {
  containerId: string;
  bottomId: string;
  depsKey: string;
  scopeKey?: string;
  pageKey?: string;
  isViewingNewest?: boolean;
};
const readingPositions = new Map<string, number>();

export function InboxAutoScroll({
  containerId,
  depsKey,
  scopeKey,
  pageKey = "newest",
  isViewingNewest = true,
}: InboxAutoScrollProps): null {
  const nearBottom = useRef(true);
  const scrollRevision = useRef(0);
  const previousPage = useRef<string | null>(null);
  const positionKey = `${scopeKey ?? depsKey.split(":")[0]}:${pageKey}`;
  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const onScroll = () => {
      scrollRevision.current += 1;
      nearBottom.current =
        container.scrollHeight - container.clientHeight - container.scrollTop <
        100;
      readingPositions.set(positionKey, container.scrollTop);
      while (readingPositions.size > 100) {
        const key = readingPositions.keys().next().value;
        if (key) readingPositions.delete(key);
        else break;
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      readingPositions.set(positionKey, container.scrollTop);
      container.removeEventListener("scroll", onScroll);
    };
  }, [containerId, positionKey]);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const openingPage = previousPage.current !== positionKey;
    previousPage.current = positionKey;
    if (!openingPage && (!isViewingNewest || !nearBottom.current)) return;
    const saved = openingPage ? readingPositions.get(positionKey) : undefined;
    const revision = scrollRevision.current;
    const frame = requestAnimationFrame(() => {
      if (scrollRevision.current !== revision) return;
      container.scrollTop =
        saved ?? (isViewingNewest ? container.scrollHeight : 0);
      nearBottom.current =
        container.scrollHeight - container.clientHeight - container.scrollTop <
        100;
    });
    return () => cancelAnimationFrame(frame);
  }, [containerId, depsKey, positionKey, isViewingNewest]);
  return null;
}
