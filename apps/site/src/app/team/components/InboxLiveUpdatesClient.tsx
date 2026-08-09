"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

const POLL_BASE_MS = 8_000;
const POLL_MAX_MS = 60_000;

type SnapshotPayload = {
  snapshot?: {
    signature?: string;
  };
};

function getComposeTextarea(): HTMLTextAreaElement | null {
  const node = document.getElementById("inbox-thread-body");
  return node instanceof HTMLTextAreaElement ? node : null;
}

function isComposeDirty(): boolean {
  const textarea = getComposeTextarea();
  return Boolean(textarea?.value?.trim().length);
}

function isComposeFocused(): boolean {
  const textarea = getComposeTextarea();
  return Boolean(textarea && document.activeElement === textarea);
}

function storeComposeDraft(storageKey: string): void {
  try {
    const textarea = getComposeTextarea();
    const value = textarea?.value ?? "";
    if (value.trim().length === 0) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    sessionStorage.setItem(storageKey, value);
  } catch {
    // Storage may be unavailable in privacy-restricted browsers.
  }
}

function restoreComposeDraft(storageKey: string): void {
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved || saved.trim().length === 0) return;
    const textarea = getComposeTextarea();
    if (!textarea || textarea.value.trim().length > 0) return;
    textarea.value = saved;
  } catch {
    // Storage may be unavailable in privacy-restricted browsers.
  }
}

function readSnapshotSignature(payload: SnapshotPayload | null): string {
  const signature = payload?.snapshot?.signature;
  if (typeof signature !== "string" || signature.trim().length === 0) {
    throw new Error("invalid_inbox_snapshot");
  }
  return signature;
}

async function fetchSnapshotSignature(
  url: URL,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`inbox_snapshot_failed:${response.status}`);
  }
  const payload = (await response
    .json()
    .catch(() => null)) as SnapshotPayload | null;
  return readSnapshotSignature(payload);
}

function retryDelayMs(failureCount: number): number {
  if (failureCount <= 0) return POLL_BASE_MS;
  return Math.min(POLL_BASE_MS * 2 ** Math.min(failureCount, 3), POLL_MAX_MS);
}

function isAbortReason(reason: unknown): boolean {
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError";
  }
  if (!reason || typeof reason !== "object" || !("name" in reason)) {
    return false;
  }
  return (reason as { name?: unknown }).name === "AbortError";
}

export function InboxLiveUpdatesClient(props: {
  threadId: string | null;
  contactId: string | null;
  channel: "sms" | "email" | "dm";
  initialTimelineSignature: string | null;
  initialThreadsSignature: string | null;
  queue: "needs_reply" | "waiting" | "failed" | "all";
  status: string | null;
  view: string | null;
  q: string | null;
  firstMessageFrom: string | null;
  firstMessageTo: string | null;
  lastMessageFrom: string | null;
  lastMessageTo: string | null;
  offset: string | null;
  isViewingNewest: boolean;
}): React.ReactElement | null {
  const router = useRouter();
  const [hasUpdate, setHasUpdate] = React.useState(false);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const timelineSignatureRef = React.useRef(props.initialTimelineSignature);
  const threadsSignatureRef = React.useRef(props.initialThreadsSignature);
  const restoreTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    timelineSignatureRef.current = props.initialTimelineSignature;
    threadsSignatureRef.current = props.initialThreadsSignature;
    setHasUpdate(false);
    setPollError(null);
  }, [
    props.threadId,
    props.channel,
    props.initialTimelineSignature,
    props.initialThreadsSignature,
  ]);

  const storageKey =
    props.threadId && props.threadId.trim().length
      ? `inbox-compose:${props.threadId}:${props.channel}`
      : `inbox-compose:unknown:${props.channel}`;

  const doRefresh = React.useCallback(
    (reason: "auto" | "manual") => {
      if (reason === "manual") storeComposeDraft(storageKey);
      router.refresh();
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
      }
      restoreTimerRef.current = window.setTimeout(() => {
        restoreComposeDraft(storageKey);
        restoreTimerRef.current = null;
      }, 350);
    },
    [router, storageKey],
  );

  React.useEffect(() => {
    restoreComposeDraft(storageKey);
  }, [storageKey]);

  React.useEffect(() => {
    return () => {
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let failureCount = 0;
    let timerId: number | null = null;
    const controller = new AbortController();

    const schedule = (delayMs: number): void => {
      if (stopped) return;
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        timerId = null;
        void tick();
      }, delayMs);
    };

    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      if (document.hidden) {
        schedule(POLL_BASE_MS);
        return;
      }

      inFlight = true;
      let nextDelay = POLL_BASE_MS;
      try {
        const timelineRequest = props.contactId
          ? (() => {
              const url = new URL(
                "/api/team/inbox/timeline",
                window.location.origin,
              );
              url.searchParams.set("contactId", props.contactId);
              url.searchParams.set("snapshot", "1");
              return fetchSnapshotSignature(url, controller.signal);
            })()
          : Promise.resolve(null);

        const threadsUrl = new URL(
          "/api/team/inbox/threads",
          window.location.origin,
        );
        threadsUrl.searchParams.set("limit", "50");
        threadsUrl.searchParams.set("snapshot", "1");
        threadsUrl.searchParams.set("queue", props.queue);
        if (props.view && props.view !== "all" && !props.q) {
          threadsUrl.searchParams.set("view", props.view);
        }
        if (props.status && props.status !== "all") {
          threadsUrl.searchParams.set("status", props.status);
        }
        if (props.q) threadsUrl.searchParams.set("q", props.q);
        if (props.firstMessageFrom) {
          threadsUrl.searchParams.set(
            "firstMessageFrom",
            props.firstMessageFrom,
          );
        }
        if (props.firstMessageTo) {
          threadsUrl.searchParams.set("firstMessageTo", props.firstMessageTo);
        }
        if (props.lastMessageFrom) {
          threadsUrl.searchParams.set("lastMessageFrom", props.lastMessageFrom);
        }
        if (props.lastMessageTo) {
          threadsUrl.searchParams.set("lastMessageTo", props.lastMessageTo);
        }
        if (props.offset) threadsUrl.searchParams.set("offset", props.offset);

        const [timelineResult, threadsResult] = await Promise.allSettled([
          timelineRequest,
          fetchSnapshotSignature(threadsUrl, controller.signal),
        ]);
        if (stopped) return;

        let changed = false;
        let failedChecks = 0;
        if (timelineResult.status === "fulfilled") {
          const signature = timelineResult.value;
          if (signature) {
            if (timelineSignatureRef.current === null) {
              timelineSignatureRef.current = signature;
            } else if (signature !== timelineSignatureRef.current) {
              timelineSignatureRef.current = signature;
              changed = true;
            }
          }
        } else if (!isAbortReason(timelineResult.reason)) {
          failedChecks += 1;
        }

        if (threadsResult.status === "fulfilled") {
          const signature = threadsResult.value;
          if (threadsSignatureRef.current === null) {
            threadsSignatureRef.current = signature;
          } else if (signature !== threadsSignatureRef.current) {
            threadsSignatureRef.current = signature;
            changed = true;
          }
        } else if (!isAbortReason(threadsResult.reason)) {
          failedChecks += 1;
        }

        if (failedChecks > 0) {
          failureCount += 1;
          nextDelay = retryDelayMs(failureCount);
          setPollError(
            "Live updates are temporarily unavailable. The conversation shown may be stale; refresh to retry.",
          );
        } else {
          failureCount = 0;
          setPollError(null);
        }

        if (changed) {
          if (
            !props.isViewingNewest ||
            isComposeDirty() ||
            isComposeFocused()
          ) {
            setHasUpdate(true);
          } else {
            setHasUpdate(false);
            doRefresh("auto");
          }
        }
      } catch (error) {
        if (!stopped && !isAbortReason(error)) {
          failureCount += 1;
          nextDelay = retryDelayMs(failureCount);
          setPollError(
            "Live updates are temporarily unavailable. The conversation shown may be stale; refresh to retry.",
          );
        }
      } finally {
        inFlight = false;
        if (!stopped) schedule(nextDelay);
      }
    };

    const onVisibilityChange = (): void => {
      if (!document.hidden && !inFlight) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(0);

    return () => {
      stopped = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [
    props.contactId,
    props.firstMessageFrom,
    props.firstMessageTo,
    props.lastMessageFrom,
    props.lastMessageTo,
    props.isViewingNewest,
    props.offset,
    props.q,
    props.queue,
    props.status,
    props.view,
    doRefresh,
  ]);

  if (!hasUpdate && !pollError) return null;

  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      role="status"
      aria-live="polite"
    >
      <span>
        {hasUpdate
          ? props.isViewingNewest
            ? "New inbox activity is ready."
            : "New inbox activity is ready. You remain on this older conversation page."
          : pollError}
        {hasUpdate && pollError ? ` ${pollError}` : null}
      </span>
      <button
        type="button"
        className="min-h-[44px] shrink-0 rounded-full bg-amber-900/90 px-4 py-2 font-semibold text-white hover:bg-amber-900"
        onClick={() => doRefresh("manual")}
      >
        {hasUpdate
          ? props.isViewingNewest
            ? "Refresh"
            : "Refresh this page"
          : "Retry now"}
      </button>
    </div>
  );
}
