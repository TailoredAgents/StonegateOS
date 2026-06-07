"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type ThreadSummary = {
  id: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
  updatedAt?: string | null;
  status?: string | null;
  state?: string | null;
};

type ThreadsPayload = {
  threads?: ThreadSummary[];
};

type TimelineMessage = {
  id: string;
  createdAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
};

type TimelinePayload = {
  messages?: TimelineMessage[];
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

function getLatestTimelineMessageAt(message: TimelineMessage | null): string | null {
  return message?.receivedAt ?? message?.sentAt ?? message?.createdAt ?? null;
}

export function InboxLiveUpdatesClient(props: {
  threadId: string | null;
  contactId: string | null;
  channel: "sms" | "email" | "dm";
  initialMessageCount: number;
  initialLastMessageAt: string | null;
  initialThreadsSignature: string;
  status: string | null;
  view: string | null;
  q: string | null;
  offset: string | null;
}): React.ReactElement | null {
  const router = useRouter();
  const [hasUpdate, setHasUpdate] = React.useState(false);

  const baselineRef = React.useRef<{ messageCount: number; lastMessageAt: string | null }>({
    messageCount: props.initialMessageCount,
    lastMessageAt: props.initialLastMessageAt
  });
  const threadsSignatureRef = React.useRef(props.initialThreadsSignature);

  React.useEffect(() => {
    baselineRef.current = { messageCount: props.initialMessageCount, lastMessageAt: props.initialLastMessageAt };
    threadsSignatureRef.current = props.initialThreadsSignature;
    setHasUpdate(false);
  }, [props.threadId, props.channel, props.initialMessageCount, props.initialLastMessageAt, props.initialThreadsSignature]);

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
    let stopped = false;
    const pollMs = 8_000;

    const tick = async () => {
      if (stopped) return;
      if (document.hidden) return;

      try {
        if (props.contactId) {
          const timelineUrl = new URL("/api/team/inbox/timeline", window.location.origin);
          timelineUrl.searchParams.set("contactId", props.contactId);
          timelineUrl.searchParams.set("limit", "50");

          const timelineRes = await fetch(timelineUrl.toString(), { method: "GET", cache: "no-store" });
          if (timelineRes.ok) {
            const payload = (await timelineRes.json().catch(() => null)) as TimelinePayload | null;
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            const latestMessage = messages.length ? messages[messages.length - 1] ?? null : null;
            const nextSnapshot = {
              messageCount: messages.length,
              lastMessageAt: getLatestTimelineMessageAt(latestMessage),
            };
            const baseline = baselineRef.current;
            const changed =
              nextSnapshot.messageCount !== baseline.messageCount ||
              (nextSnapshot.lastMessageAt ?? null) !== (baseline.lastMessageAt ?? null);

            if (changed) {
              if (isComposeDirty() || isComposeFocused()) {
                setHasUpdate(true);
                return;
              }

              baselineRef.current = nextSnapshot;
              setHasUpdate(false);
              doRefresh("auto");
              return;
            }
          }
        }

        const threadsUrl = new URL("/api/team/inbox/threads", window.location.origin);
        threadsUrl.searchParams.set("limit", props.q ? "200" : "50");
        if (props.view && props.view !== "all" && !props.q) threadsUrl.searchParams.set("view", props.view);
        if (props.status && props.status !== "all") threadsUrl.searchParams.set("status", props.status);
        if (props.q) threadsUrl.searchParams.set("q", props.q);
        if (props.offset) threadsUrl.searchParams.set("offset", props.offset);

        const threadsRes = await fetch(threadsUrl.toString(), { method: "GET", cache: "no-store" });
        if (!threadsRes.ok) return;
        const threadsPayload = (await threadsRes.json().catch(() => null)) as ThreadsPayload | null;
        const threads = Array.isArray(threadsPayload?.threads) ? threadsPayload.threads : [];
        const nextThreadsSignature = threads
          .map((thread) =>
            [
              thread.id,
              thread.messageCount,
              thread.lastMessageAt ?? "",
              thread.lastInboundAt ?? "",
              thread.updatedAt ?? "",
              thread.status ?? "",
              thread.state ?? "",
            ].join(":"),
          )
          .join("|");

        if (nextThreadsSignature && nextThreadsSignature !== threadsSignatureRef.current) {
          if (isComposeDirty() || isComposeFocused()) {
            setHasUpdate(true);
            return;
          }

          threadsSignatureRef.current = nextThreadsSignature;
          setHasUpdate(false);
          doRefresh("auto");
        }
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
  }, [props.contactId, props.offset, props.q, props.status, props.view, doRefresh]);

  if (!hasUpdate) return null;

  return (
    <div className="mb-3 flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <span>New inbox activity.</span>
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
