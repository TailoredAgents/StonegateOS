"use client";

import * as React from "react";
import {
  CheckCheck,
  CircleAlert,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Send,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  type PortalV2Error,
} from "../lib/portal-v2";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

const MAX_MESSAGE_LENGTH = 5_000;

export type PartnerJobMessage = {
  id: string;
  authorType: string;
  direction: string;
  channel: string;
  body: string;
  deliveryStatus: string | null;
  attachmentIds: string[];
  sentAt?: string | null;
  receivedAt?: string | null;
  createdAt: string;
  system?: boolean;
};

export type PartnerMessagePage = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type PartnerMessagesPayload = {
  ok: true;
  thread: { id: string } | null;
  messages: PartnerJobMessage[];
  page: PartnerMessagePage;
};

type PendingSend = {
  body: string;
  idempotencyKey: string;
};

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatMessageTime(value: string, timezone: string): string {
  const date = validDate(value);
  if (!date) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function normalizeDeliveryStatus(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const labels: Record<string, string> = {
    queued: "Queued",
    sending: "Sending",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
    failed: "Delivery failed",
    undelivered: "Undelivered",
  };
  return labels[normalized] ?? normalized.replace(/[-_]+/gu, " ");
}

function sortMessages(messages: PartnerJobMessage[]): PartnerJobMessage[] {
  return [...messages].sort((left, right) => {
    const dateOrder = left.createdAt.localeCompare(right.createdAt);
    return dateOrder || left.id.localeCompare(right.id);
  });
}

function mergeMessages(
  current: PartnerJobMessage[],
  incoming: PartnerJobMessage[],
): PartnerJobMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return sortMessages([...byId.values()]);
}

function failureMessage(error: PortalV2Error | null, fallback: string): string {
  const message = error?.message.trim();
  return message || fallback;
}

export function PartnerJobMessages({
  jobId,
  timezone,
  canSend,
  initialMessages,
  initialPage,
  initialUnreadCount,
  initialError,
}: {
  jobId: string;
  timezone: string;
  canSend: boolean;
  initialMessages: PartnerJobMessage[];
  initialPage: PartnerMessagePage;
  initialUnreadCount?: number;
  initialError?: string | null;
}) {
  const [messages, setMessages] = React.useState(() =>
    sortMessages(initialMessages),
  );
  const [page, setPage] = React.useState(initialPage);
  const [historyError, setHistoryError] = React.useState(initialError ?? null);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [pendingSend, setPendingSend] = React.useState<PendingSend | null>(null);
  const [sendConfirmation, setSendConfirmation] = React.useState<string | null>(null);
  const messageListRef = React.useRef<HTMLDivElement>(null);
  const previousMessageCountRef = React.useRef(messages.length);
  const trimmedDraft = draft.trim();
  const charactersRemaining = MAX_MESSAGE_LENGTH - draft.length;

  React.useEffect(() => {
    if (messages.length <= previousMessageCountRef.current) return;
    previousMessageCountRef.current = messages.length;
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  const loadMessages = React.useCallback(
    async (cursor?: string | null): Promise<void> => {
      setLoadingHistory(true);
      setHistoryError(null);
      const query = new URLSearchParams({ limit: String(page.limit || 50) });
      if (cursor) query.set("cursor", cursor);
      const result = await partnerPortalFetch<PartnerMessagesPayload>(
        `jobs/${encodeURIComponent(jobId)}/messages?${query.toString()}`,
      ).catch(() => null);
      setLoadingHistory(false);
      if (!result?.ok) {
        setHistoryError(
          failureMessage(
            result?.error ?? null,
            "Messages couldn’t be refreshed. No message was changed.",
          ),
        );
        return;
      }
      setMessages((current) =>
        cursor
          ? mergeMessages(current, result.data.messages)
          : sortMessages(result.data.messages),
      );
      setPage(result.data.page);
    },
    [jobId, page.limit],
  );

  const sendMessage = React.useCallback(
    async (operation: PendingSend): Promise<void> => {
      setSending(true);
      setSendError(null);
      setSendConfirmation(null);
      const result = await partnerPortalFetch<{
        ok: true;
        threadId: string;
        message: PartnerJobMessage;
      }>(`jobs/${encodeURIComponent(jobId)}/messages`, {
        method: "POST",
        headers: { "Idempotency-Key": operation.idempotencyKey },
        body: JSON.stringify({ body: operation.body, attachmentIds: [] }),
      }).catch(() => null);
      setSending(false);
      if (!result?.ok) {
        setPendingSend(operation);
        setSendError(
          failureMessage(
            result?.error ?? null,
            "Your message wasn’t confirmed. Retry to safely send the same message.",
          ),
        );
        return;
      }
      setMessages((current) => mergeMessages(current, [result.data.message]));
      setDraft("");
      setPendingSend(null);
      setSendConfirmation("Message sent to Stonegate.");
    },
    [jobId],
  );

  const submitMessage = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!trimmedDraft || trimmedDraft.length > MAX_MESSAGE_LENGTH || sending) {
      return;
    }
    const operation =
      pendingSend?.body === trimmedDraft
        ? pendingSend
        : {
            body: trimmedDraft,
            idempotencyKey: createPortalOperationKey("job-message"),
          };
    setPendingSend(operation);
    void sendMessage(operation);
  };

  const retryPendingSend = (): void => {
    if (pendingSend && !sending) void sendMessage(pendingSend);
  };

  return (
    <section aria-labelledby="job-messages-heading">
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <MessageSquareText className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="job-messages-heading" className="text-lg font-semibold text-slate-950">
                Job messages
              </h2>
              {typeof initialUnreadCount === "number" && initialUnreadCount > 0 ? (
                <span
                  className="inline-flex rounded-full bg-primary-100 px-2.5 py-1 text-xs font-semibold text-primary-800"
                  aria-label={`${initialUnreadCount} unread ${initialUnreadCount === 1 ? "message" : "messages"}`}
                >
                  {initialUnreadCount} new
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Keep job-specific updates with the Stonegate service team.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadMessages(null)}
          disabled={loadingHistory}
          className={cn(partnerSecondaryButtonClass, "shrink-0")}
        >
          {loadingHistory ? (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Refresh
        </button>
      </div>

      {historyError ? (
        <div className="mt-4">
          <PartnerNotice tone="error">
            <div>
              <p>{historyError}</p>
              <button
                type="button"
                onClick={() => void loadMessages(null)}
                disabled={loadingHistory}
                className="mt-2 min-h-11 rounded-lg font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                Try loading messages again
              </button>
            </div>
          </PartnerNotice>
        </div>
      ) : (
        <div
          ref={messageListRef}
          className="mt-4 max-h-[32rem] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Job message history"
          tabIndex={0}
        >
          {messages.length ? (
            <ol className="space-y-3">
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} timezone={timezone} />
              ))}
            </ol>
          ) : (
            <div className="flex min-h-36 flex-col items-center justify-center px-4 text-center">
              <MessageSquareText className="h-6 w-6 text-slate-400" aria-hidden="true" />
              <p className="mt-3 font-semibold text-slate-900">No messages yet</p>
              <p className="mt-1 max-w-sm text-sm leading-6 text-slate-600">
                {canSend
                  ? "Send the first update or question about this job below."
                  : "Job-specific updates from Stonegate will appear here."}
              </p>
            </div>
          )}
        </div>
      )}

      {!historyError && page.hasMore && page.nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMessages(page.nextCursor)}
          disabled={loadingHistory}
          className={cn(partnerSecondaryButtonClass, "mt-3 w-full")}
        >
          {loadingHistory ? (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : null}
          {loadingHistory ? "Loading…" : "Load newer messages"}
        </button>
      ) : null}

      {canSend ? (
        <form onSubmit={submitMessage} className="mt-5 border-t border-slate-200 pt-5" data-partner-analytics="job_message_send">
          <label htmlFor="partner-job-message" className="text-sm font-semibold text-slate-900">
            Message Stonegate
          </label>
          <textarea
            id="partner-job-message"
            value={draft}
            onChange={(event) => {
              const nextDraft = event.currentTarget.value;
              setDraft(nextDraft);
              setSendConfirmation(null);
              if (pendingSend && pendingSend.body !== nextDraft.trim()) {
                setPendingSend(null);
                setSendError(null);
              }
            }}
            required
            maxLength={MAX_MESSAGE_LENGTH}
            rows={4}
            disabled={sending}
            aria-describedby="partner-job-message-help partner-job-message-count"
            className={cn(partnerFieldClass, "resize-y")}
            placeholder="Share an access update, timing question, or other detail about this job."
          />
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs leading-5 text-slate-500">
              <p id="partner-job-message-help">Don’t include passwords, payment card details, or access codes.</p>
              <p
                id="partner-job-message-count"
                className={charactersRemaining < 100 ? "font-semibold text-amber-700" : undefined}
              >
                {charactersRemaining.toLocaleString()} characters remaining
              </p>
            </div>
            <button
              type="submit"
              disabled={sending || !trimmedDraft || trimmedDraft.length > MAX_MESSAGE_LENGTH}
              className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
            >
              {sending ? (
                <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              {sending ? "Sending…" : "Send message"}
            </button>
          </div>

          {sendError ? (
            <div className="mt-4">
              <PartnerNotice tone="error">
                <div>
                  <p>{sendError}</p>
                  {pendingSend ? (
                    <button
                      type="button"
                      onClick={retryPendingSend}
                      disabled={sending}
                      className="mt-2 min-h-11 rounded-lg font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                    >
                      Retry this message
                    </button>
                  ) : null}
                </div>
              </PartnerNotice>
            </div>
          ) : null}
          {sendConfirmation ? (
            <div className="mt-4">
              <PartnerNotice tone="success">{sendConfirmation}</PartnerNotice>
            </div>
          ) : null}
        </form>
      ) : (
        <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Your portal role can view this conversation but cannot send messages.
        </p>
      )}
    </section>
  );
}

function MessageItem({
  message,
  timezone,
}: {
  message: PartnerJobMessage;
  timezone: string;
}) {
  const mine = message.authorType.trim().toLowerCase() === "partner";
  const system = message.system === true || message.authorType.trim().toLowerCase() === "system";
  const deliveryLabel = normalizeDeliveryStatus(message.deliveryStatus);
  const deliveryFailed = ["failed", "undelivered"].includes(
    message.deliveryStatus?.trim().toLowerCase() ?? "",
  );

  if (system) {
    return (
      <li className="px-2 py-1 text-center">
        <p className="break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">
          {message.body}
        </p>
        <time dateTime={message.createdAt} className="mt-1 block text-[0.6875rem] text-slate-400">
          {formatMessageTime(message.createdAt, timezone)}
        </time>
      </li>
    );
  }

  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <article
        className={cn(
          "max-w-[92%] rounded-2xl px-4 py-3 shadow-sm sm:max-w-[78%]",
          mine
            ? "rounded-br-md bg-primary-700 text-white"
            : "rounded-bl-md border border-slate-200 bg-white text-slate-900",
        )}
        aria-label={mine ? "Message from you" : "Message from Stonegate"}
      >
        <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
          {message.body}
        </p>
        <div
          className={cn(
            "mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]",
            mine ? "text-primary-100" : "text-slate-500",
          )}
        >
          <time dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt, timezone)}
          </time>
          {deliveryLabel ? (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                deliveryFailed ? (mine ? "font-semibold text-rose-100" : "font-semibold text-rose-700") : null,
              )}
            >
              {deliveryFailed ? (
                <CircleAlert className="h-3 w-3" aria-hidden="true" />
              ) : (
                <CheckCheck className="h-3 w-3" aria-hidden="true" />
              )}
              {deliveryLabel}
            </span>
          ) : null}
        </div>
      </article>
    </li>
  );
}
