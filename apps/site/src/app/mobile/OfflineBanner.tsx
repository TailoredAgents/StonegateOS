"use client";

import * as React from "react";

export function OfflineBanner() {
  const [isOffline, setIsOffline] = React.useState(false);
  const [blockedSubmit, setBlockedSubmit] = React.useState(false);

  React.useEffect(() => {
    const update = () => {
      const offline = !navigator.onLine;
      setIsOffline(offline);
      if (!offline) setBlockedSubmit(false);
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  React.useEffect(() => {
    if (!isOffline) return;

    const blockOfflineSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      setBlockedSubmit(true);
    };

    document.addEventListener("submit", blockOfflineSubmit, true);
    return () => document.removeEventListener("submit", blockOfflineSubmit, true);
  }, [isOffline]);

  if (!isOffline) return null;

  return (
    <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100" role="status">
      <p className="font-semibold">Offline</p>
      <p>Messages, quotes, uploads, and edits need signal before they can be submitted.</p>
      {blockedSubmit ? <p className="mt-2 text-amber-50">Submission blocked. Try again when the phone is back online.</p> : null}
    </div>
  );
}
