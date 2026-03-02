"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type ThreadSummary = {
  id: string;
  messageCount: number;
  lastMessageAt: string | null;
};

type ThreadsPayload = {
  threads?: ThreadSummary[];
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
    // ignore
  }
}

function restoreComposeDraft(storageKey: string): void {
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved || saved.trim().length === 0) return;
    const textarea = getComposeTextarea();
    if (!textarea) return;
    if (textarea.value.trim().length > 0) return;
    textarea.value = saved;
  } catch {
    // ignore
  }
}

export function InboxLiveUpdatesClient(props: {
  threadId: string | null;
  contactId: string | null;
  channel: "sms" | "email" | "dm";
  initialMessageCount: number;
  initialLastMessageAt: string | null;
}): React.ReactElement | null {
  const router = useRouter();
  const [hasUpdate, setHasUpdate] = React.useState(false);

  const baselineRef = React.useRef<{ messageCount: number; lastMessageAt: string | null }>({
    messageCount: props.initialMessageCount,
    lastMessageAt: props.initialLastMessageAt
  });

  React.useEffect(() => {
    baselineRef.current = { messageCount: props.initialMessageCount, lastMessageAt: props.initialLastMessageAt };
    setHasUpdate(false);
  }, [props.threadId, props.channel, props.initialMessageCount, props.initialLastMessageAt]);

  const storageKey =
    props.threadId && props.threadId.trim().length
      ? `inbox-compose:${props.threadId}:${props.channel}`
      : `inbox-compose:unknown:${props.channel}`;

  const doRefresh = React.useCallback(
    (reason: "auto" | "manual") => {
      if (reason === "manual") {
        storeComposeDraft(storageKey);
      }
      router.refresh();
      // If the server-rendered textarea gets replaced during refresh, attempt to restore the draft.
      const t = window.setTimeout(() => restoreComposeDraft(storageKey), 350);
      return () => window.clearTimeout(t);
    },
    [router, storageKey]
  );

  React.useEffect(() => {
    restoreComposeDraft(storageKey);
  }, [storageKey]);

  React.useEffect(() => {
    if (!props.threadId || !props.contactId) return;

    let stopped = false;
    const contactId = props.contactId;
    const threadId = props.threadId;
    const pollMs = 8_000;

    const tick = async () => {
      if (stopped) return;
      if (document.hidden) return;

      try {
        const url = new URL("/api/team/inbox/threads", window.location.origin);
        url.searchParams.set("contactId", contactId);
        url.searchParams.set("channel", props.channel);
        url.searchParams.set("limit", "25");

        const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json().catch(() => null)) as ThreadsPayload | null;
        const thread = payload?.threads?.find((t) => t.id === threadId) ?? null;
        if (!thread) return;

        const baseline = baselineRef.current;
        const changed =
          thread.messageCount !== baseline.messageCount || (thread.lastMessageAt ?? null) !== (baseline.lastMessageAt ?? null);
        if (!changed) return;

        if (isComposeDirty() || isComposeFocused()) {
          setHasUpdate(true);
          return;
        }

        baselineRef.current = { messageCount: thread.messageCount, lastMessageAt: thread.lastMessageAt ?? null };
        setHasUpdate(false);
        doRefresh("auto");
      } catch {
        // ignore poll errors
      }
    };

    const timerId = window.setInterval(() => void tick(), pollMs);
    void tick();

    return () => {
      stopped = true;
      window.clearInterval(timerId);
    };
  }, [props.threadId, props.contactId, props.channel, doRefresh]);

  if (!hasUpdate) return null;

  return (
    <div className="mb-3 flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <span>New activity in this thread.</span>
      <button
        type="button"
        className="rounded-full bg-amber-900/90 px-3 py-1 font-semibold text-white hover:bg-amber-900"
        onClick={() => doRefresh("manual")}
      >
        Refresh
      </button>
    </div>
  );
}
