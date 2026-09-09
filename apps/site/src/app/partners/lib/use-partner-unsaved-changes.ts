"use client";

import { useEffect, useId } from "react";

const pending = new Set<string>();
const checkedLinks = new WeakSet<Event>();

export function confirmPartnerNavigation(): boolean {
  return (
    pending.size === 0 ||
    window.confirm(
      "You have unsaved changes or uploads. Leave this page without them?",
    )
  );
}

export function usePartnerUnsavedChanges(active: boolean) {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    pending.add(id);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeLink = (event: MouseEvent) => {
      if (checkedLinks.has(event)) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element | null)?.closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      checkedLinks.add(event);
      if (!confirmPartnerNavigation()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLink, true);
    return () => {
      pending.delete(id);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLink, true);
    };
  }, [active, id]);
}
