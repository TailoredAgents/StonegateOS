"use client";

import { useEffect } from "react";

type InboxAutoScrollProps = {
  containerId: string;
  bottomId: string;
  depsKey: string;
};

export function InboxAutoScroll({ containerId, bottomId, depsKey }: InboxAutoScrollProps): null {
  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;

    const run = () => {
      const bottom = document.getElementById(bottomId);
      if (bottom) {
        bottom.scrollIntoView({ block: "end" });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    };

    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }, [containerId, bottomId, depsKey]);

  return null;
}

