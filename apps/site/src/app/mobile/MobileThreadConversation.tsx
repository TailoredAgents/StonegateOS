"use client";

import type { FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { MobileInboxMediaGallery } from "./MobileInboxMediaGallery";

type MessageDetail = {
  id: string;
  direction: string;
  channel: string;
  body: string;
  mediaUrls?: string[];
  deliveryStatus: string;
  participantName: string | null;
  createdAt: string;
};

type ThreadResponse = {
  messages?: MessageDetail[];
};

type OptimisticMessage = MessageDetail & {
  optimistic: true;
};

type ConversationMessage = MessageDetail | OptimisticMessage;

type MobileThreadConversationProps = {
  threadId: string;
  channel: string;
  initialMessages: MessageDetail[];
};

function formatRelativeTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMinutes < 1) return "Now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isMediaPlaceholderBody(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "media message" || normalized === "message received";
}

function hasServerMatch(optimistic: OptimisticMessage, serverMessages: MessageDetail[]): boolean {
  const optimisticAt = Date.parse(optimistic.createdAt);
  return serverMessages.some((message) => {
    if (message.direction !== "outbound") return false;
    if (message.body.trim() !== optimistic.body.trim()) return false;
    const messageAt = Date.parse(message.createdAt);
    if (!Number.isFinite(optimisticAt) || !Number.isFinite(messageAt)) return true;
    return Math.abs(messageAt - optimisticAt) < 5 * 60_000;
  });
}

function mergeMessages(current: ConversationMessage[], serverMessages: MessageDetail[]): ConversationMessage[] {
  const optimisticMessages = current.filter(
    (message): message is OptimisticMessage => "optimistic" in message && message.optimistic
  );
  const unmatchedOptimistic = optimisticMessages.filter((message) => !hasServerMatch(message, serverMessages));
  return [...serverMessages, ...unmatchedOptimistic].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function MobileThreadConversation({
  threadId,
  channel,
  initialMessages
}: MobileThreadConversationProps): ReactElement {
  const [messages, setMessages] = useState<ConversationMessage[]>(initialMessages);
  const [body, setBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMessages(initialMessages);
    setLastSyncedAt(new Date());
  }, [initialMessages, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const refreshThread = useCallback(
    async (options?: { quiet?: boolean }) => {
      refreshAbortRef.current?.abort();
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      if (!options?.quiet) setIsRefreshing(true);

      try {
        const response = await fetch(`/api/mobile/inbox/threads/${encodeURIComponent(threadId)}`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store"
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as ThreadResponse | null;
        if (!Array.isArray(payload?.messages)) return;
        setMessages((current) => mergeMessages(current, payload.messages ?? []));
        setLastSyncedAt(new Date());
      } catch (refreshError) {
        if (refreshError instanceof DOMException && refreshError.name === "AbortError") return;
      } finally {
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
        if (!options?.quiet) setIsRefreshing(false);
      }
    },
    [threadId]
  );

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void refreshThread({ quiet: true });
    };
    const interval = window.setInterval(poll, 4000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshThread({ quiet: true });
    };
    const onFocus = () => void refreshThread({ quiet: true });

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      refreshAbortRef.current?.abort();
    };
  }, [refreshThread]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || isSending) return;

    const optimisticId = `pending-${Date.now()}`;
    const optimisticMessage: OptimisticMessage = {
      id: optimisticId,
      direction: "outbound",
      channel,
      body: trimmed,
      mediaUrls: [],
      deliveryStatus: "sending",
      participantName: null,
      createdAt: new Date().toISOString(),
      optimistic: true
    };

    setBody("");
    setError(null);
    setIsSending(true);
    setMessages((current) => [...current, optimisticMessage]);

    try {
      const response = await fetch(`/api/mobile/inbox/threads/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, channel })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "send_failed");
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticId ? { ...message, deliveryStatus: "sent" } : message
        )
      );
      window.setTimeout(() => {
        void refreshThread({ quiet: true });
      }, 500);
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "send_failed";
      setError(message);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === optimisticId ? { ...entry, deliveryStatus: "failed" } : entry
        )
      );
      setBody(trimmed);
    } finally {
      setIsSending(false);
    }
  }

  const syncLabel = useMemo(() => {
    if (isRefreshing) return "Syncing";
    if (!lastSyncedAt) return "Live";
    return `Synced ${formatRelativeTime(lastSyncedAt.toISOString())}`;
  }, [isRefreshing, lastSyncedAt]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-slate-400">
        <span>{syncLabel}</span>
        <button
          type="button"
          onClick={() => void refreshThread()}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-slate-900 px-2.5 py-1 font-semibold text-slate-200"
          aria-label="Refresh thread"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="space-y-3 p-4">
        {messages.length > 0 ? (
          messages.map((message) => {
            const outbound = message.direction === "outbound";
            const mediaCount = message.mediaUrls?.length ?? 0;
            const hasMedia = mediaCount > 0;
            const showBody = !isMediaPlaceholderBody(message.body) || !hasMedia;
            const optimistic = "optimistic" in message && message.optimistic;
            return (
              <div key={message.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[82%] rounded-lg px-3 py-2 text-sm leading-6 shadow-sm transition ${
                    outbound ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-slate-100"
                  } ${optimistic ? "opacity-90" : ""}`}
                >
                  {showBody ? <p className="whitespace-pre-wrap break-words">{message.body || "Message received"}</p> : null}
                  {hasMedia ? <MobileInboxMediaGallery messageId={message.id} count={mediaCount} /> : null}
                  <p className={`mt-1 text-[11px] ${outbound ? "text-slate-700" : "text-slate-400"}`}>
                    {formatRelativeTime(message.createdAt)} • {message.deliveryStatus}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm text-slate-300">
            No messages yet.
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="border-t border-white/10 p-4">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        ) : null}
        <label className="block">
          <span className="text-xs font-semibold text-slate-300">Reply</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none transition focus:border-cyan-300"
            placeholder="Type a reply..."
          />
        </label>
        <button
          type="submit"
          disabled={isSending || body.trim().length === 0}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {isSending ? "Sending" : "Send reply"}
        </button>
      </form>
    </>
  );
}
