"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type InboxRefreshProps = {
  threadId?: string;
};

export function InboxRefresh({ threadId }: InboxRefreshProps): null {
  const router = useRouter();

  useEffect(() => {
    let lastRefresh = 0;
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefresh < 3000) return;
      lastRefresh = now;
      router.refresh();
    };

    const interval = window.setInterval(refresh, threadId ? 10000 : 15000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onFocus = () => refresh();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [router, threadId]);

  return null;
}
