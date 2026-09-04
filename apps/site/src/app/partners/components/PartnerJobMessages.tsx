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
  kind?: "message" | "issue";
  issue?: {
    category:
      | "access"
      | "safety"
      | "property_damage"
      | "service_quality"
      | "schedule"
      | "other";
    categoryLabel: string;
    priority: "standard" | "urgent";
  } | null;
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

type PartnerIssueCategory = NonNullable<PartnerJobMessage["issue"]>["category"];
type PartnerIssuePriority = NonNullable<PartnerJobMessage["issue"]>["priority"];
type PendingSend =
  | {
      kind: "message";
      body: string;
      idempotencyKey: string;
    }
  | {
      kind: "issue";
      body: string;
      category: PartnerIssueCategory;
      priority: PartnerIssuePriority;
      idempotencyKey: string;
    };

const ISSUE_CATEGORIES: ReadonlyArray<{
  key: PartnerIssueCategory;
  label: string;
}> = [
  { key: "access", label: "Access issue" },
  { key: "safety", label: "Safety concern" },
  { key: "property_damage", label: "Property damage" },
  { key: "service_quality", label: "Service quality" },
  { key: "schedule", label: "Schedule issue" },
  { key: "other", label: "Other issue" },
];

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
  const [issueDraft, setIssueDraft] = React.useState("");
  const [issueCategory, setIssueCategory] =
    React.useState<PartnerIssueCategory>("access");
  const [issuePriority, setIssuePriority] =
    React.useState<PartnerIssuePriority>("standard");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [pendingSend, setPendingSend] = React.useState<PendingSend | null>(
    null,
  );
  const [sendConfirmation, setSendConfirmation] = React.useState<string | null>(
    null,
  );
  const messageListRef = React.useRef<HTMLDivElement>(null);
  const previousMessageCountRef = React.useRef(messages.length);
  const trimmedDraft = draft.trim();
  const charactersRemaining = MAX_MESSAGE_LENGTH - draft.length;
  const trimmedIssueDraft = issueDraft.trim();
  const issueCharactersRemaining = 2_000 - issueDraft.length;

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
        body: JSON.stringify(
          operation.kind === "issue"
            ? {
                kind: "issue",
                body: operation.body,
                attachmentIds: [],
                issueCategory: operation.category,
                issuePriority: operation.priority,
              }
            : {
                kind: "message",
                body: operation.body,
                attachmentIds: [],
              },
        ),
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
      if (operation.kind === "issue") {
        setIssueDraft("");
      } else {
        setDraft("");
      }
      setPendingSend(null);
      setSendConfirmation(
        operation.kind === "issue"
          ? "Issue reported to Stonegate and saved with this job."
          : "Message sent to Stonegate.",
      );
    },
    [jobId],
  );

  const submitMessage = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!trimmedDraft || trimmedDraft.length > MAX_MESSAGE_LENGTH || sending) {
      return;
    }
    const operation: PendingSend =
      pendingSend?.kind === "message" && pendingSend.body === trimmedDraft
        ? pendingSend
        : {
            kind: "message",
            body: trimmedDraft,
            idempotencyKey: createPortalOperationKey("job-message"),
          };
    setPendingSend(operation);
    void sendMessage(operation);
  };

  const retryPendingSend = (): void => {
    if (pendingSend && !sending) void sendMessage(pendingSend);
  };

  const submitIssue = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      trimmedIssueDraft.length < 10 ||
      trimmedIssueDraft.length > 2_000 ||
      sending
    ) {
      return;
    }
    const operation: PendingSend =
      pendingSend?.kind === "issue" &&
      pendingSend.body === trimmedIssueDraft &&
      pendingSend.category === issueCategory &&
      pendingSend.priority === issuePriority
        ? pendingSend
        : {
            kind: "issue",
            body: trimmedIssueDraft,
            category: issueCategory,
            priority: issuePriority,
            idempotencyKey: createPortalOperationKey("job-issue"),
          };
    setPendingSend(operation);
    void sendMessage(operation);
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
              <h2
                id="job-messages-heading"
                className="text-lg font-semibold text-slate-950"
              >
                Keep this job moving
              </h2>
              {typeof initialUnreadCount === "number" &&
              initialUnreadCount > 0 ? (
                <span
                  className="inline-flex rounded-full bg-primary-100 px-2.5 py-1 text-xs font-semibold text-primary-800"
                  aria-label={`${initialUnreadCount} unread ${initialUnreadCount === 1 ? "message" : "messages"}`}
                >
                  {initialUnreadCount} new
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Send updates or questions directly to the Stonegate service team.
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
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
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
                <MessageItem
                  key={message.id}
                  message={message}
                  timezone={timezone}
                />
              ))}
            </ol>
          ) : (
            <div className="flex min-h-36 flex-col items-center justify-center px-4 text-center">
              <MessageSquareText
                className="h-6 w-6 text-slate-400"
                aria-hidden="true"
              />
              <p className="mt-3 font-semibold text-slate-900">
                No updates yet
              </p>
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
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {loadingHistory ? "Loading…" : "Load newer messages"}
        </button>
      ) : null}

      {canSend ? (
        <>
          <form
            onSubmit={submitMessage}
            className="mt-5 border-t border-slate-200 pt-5"
            data-partner-analytics="job_message_send"
          >
            <label
              htmlFor="partner-job-message"
              className="text-sm font-semibold text-slate-900"
            >
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
                <p id="partner-job-message-help">
                  Don’t include passwords, payment card details, or access
                  codes.
                </p>
                <p
                  id="partner-job-message-count"
                  className={
                    charactersRemaining < 100
                      ? "font-semibold text-amber-700"
                      : undefined
                  }
                >
                  {charactersRemaining.toLocaleString()} characters remaining
                </p>
              </div>
              <button
                type="submit"
                disabled={
                  sending ||
                  !trimmedDraft ||
                  trimmedDraft.length > MAX_MESSAGE_LENGTH
                }
                className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
              >
                {sending ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                {sending ? "Sending…" : "Send message"}
              </button>
            </div>
          </form>
          <details className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/50 px-4 py-3">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg font-semibold text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2">
              <CircleAlert
                className="h-5 w-5 text-amber-700"
                aria-hidden="true"
              />
              Report a job issue
            </summary>
            <form
              onSubmit={submitIssue}
              className="mt-3 border-t border-amber-200 pt-4"
              data-partner-analytics="job_issue_report"
            >
              <p
                id="partner-job-issue-emergency"
                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold leading-6 text-rose-900"
              >
                For immediate danger or a medical emergency, call 911. This form
                does not guarantee an immediate response.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="partner-job-issue-category"
                    className="text-sm font-semibold text-slate-900"
                  >
                    Issue type
                  </label>
                  <select
                    id="partner-job-issue-category"
                    value={issueCategory}
                    onChange={(event) => {
                      setIssueCategory(
                        event.currentTarget.value as PartnerIssueCategory,
                      );
                      if (pendingSend?.kind === "issue") {
                        setPendingSend(null);
                        setSendError(null);
                      }
                    }}
                    disabled={sending}
                    className={partnerFieldClass}
                  >
                    {ISSUE_CATEGORIES.map((category) => (
                      <option key={category.key} value={category.key}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </div>
                <fieldset disabled={sending}>
                  <legend className="text-sm font-semibold text-slate-900">
                    Priority
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {(["standard", "urgent"] as const).map((priority) => (
                      <label
                        key={priority}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"
                      >
                        <input
                          type="radio"
                          name="partner-job-issue-priority"
                          value={priority}
                          checked={issuePriority === priority}
                          onChange={() => {
                            setIssuePriority(priority);
                            if (pendingSend?.kind === "issue") {
                              setPendingSend(null);
                              setSendError(null);
                            }
                          }}
                          className="h-5 w-5 accent-primary-700"
                        />
                        {priority === "urgent" ? "Urgent" : "Standard"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <label
                htmlFor="partner-job-issue-details"
                className="mt-4 block text-sm font-semibold text-slate-900"
              >
                What happened?
              </label>
              <textarea
                id="partner-job-issue-details"
                value={issueDraft}
                onChange={(event) => {
                  const nextDraft = event.currentTarget.value;
                  setIssueDraft(nextDraft);
                  setSendConfirmation(null);
                  if (
                    pendingSend?.kind === "issue" &&
                    pendingSend.body !== nextDraft.trim()
                  ) {
                    setPendingSend(null);
                    setSendError(null);
                  }
                }}
                required
                minLength={10}
                maxLength={2_000}
                rows={4}
                disabled={sending}
                aria-describedby="partner-job-issue-emergency partner-job-issue-help partner-job-issue-count"
                className={cn(partnerFieldClass, "resize-y")}
                placeholder="Describe the issue, where it occurred, and what you need Stonegate to review."
              />
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs leading-5 text-slate-600">
                  <p id="partner-job-issue-help">
                    Do not include passwords, payment card details, or access
                    codes. Your report stays with this job for follow-up.
                  </p>
                  <p
                    id="partner-job-issue-count"
                    className={
                      issueCharactersRemaining < 100
                        ? "font-semibold text-amber-800"
                        : undefined
                    }
                  >
                    {issueCharactersRemaining.toLocaleString()} characters
                    remaining
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={
                    sending ||
                    trimmedIssueDraft.length < 10 ||
                    trimmedIssueDraft.length > 2_000
                  }
                  className={cn(partnerPrimaryButtonClass, "w-full sm:w-auto")}
                >
                  {sending && pendingSend?.kind === "issue" ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleAlert className="h-4 w-4" aria-hidden="true" />
                  )}
                  {sending && pendingSend?.kind === "issue"
                    ? "Reporting…"
                    : "Report issue"}
                </button>
              </div>
            </form>
          </details>
          {sendError ? (
            <div className="mt-4" aria-live="assertive">
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
                      Retry this{" "}
                      {pendingSend.kind === "issue"
                        ? "issue report"
                        : "message"}
                    </button>
                  ) : null}
                </div>
              </PartnerNotice>
            </div>
          ) : null}
          {sendConfirmation ? (
            <div className="mt-4" aria-live="polite">
              <PartnerNotice tone="success">{sendConfirmation}</PartnerNotice>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          You can read this conversation, but your account access does not allow
          sending messages.
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
  const system =
    message.system === true ||
    message.authorType.trim().toLowerCase() === "system";
  const deliveryLabel = normalizeDeliveryStatus(message.deliveryStatus);
  const deliveryFailed = ["failed", "undelivered"].includes(
    message.deliveryStatus?.trim().toLowerCase() ?? "",
  );
  const issueCategory =
    message.kind === "issue" && message.issue
      ? (ISSUE_CATEGORIES.find(
          (category) => category.key === message.issue?.category,
        ) ?? null)
      : null;
  const issuePriority =
    issueCategory &&
    (message.issue?.priority === "standard" ||
      message.issue?.priority === "urgent")
      ? message.issue.priority
      : null;

  if (system) {
    return (
      <li className="px-2 py-1 text-center">
        <p className="break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">
          {message.body}
        </p>
        <time
          dateTime={message.createdAt}
          className="mt-1 block text-[0.6875rem] text-slate-400"
        >
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
          issuePriority === "urgent"
            ? mine
              ? "ring-2 ring-rose-200"
              : "border-rose-300 ring-1 ring-rose-200"
            : issueCategory
              ? mine
                ? "ring-2 ring-amber-200"
                : "border-amber-300"
              : null,
        )}
        aria-label={
          issueCategory
            ? `${issuePriority === "urgent" ? "Urgent " : ""}${issueCategory.label} reported ${mine ? "by you" : "by Stonegate"}`
            : mine
              ? "Message from you"
              : "Message from Stonegate"
        }
      >
        {issueCategory ? (
          <p
            className={cn(
              "mb-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide",
              mine
                ? "bg-white/15 text-white"
                : issuePriority === "urgent"
                  ? "bg-rose-100 text-rose-800"
                  : "bg-amber-100 text-amber-900",
            )}
          >
            <CircleAlert className="h-3 w-3" aria-hidden="true" />
            {issuePriority === "urgent" ? "Urgent · " : ""}
            {issueCategory.label}
          </p>
        ) : null}
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
                deliveryFailed
                  ? mine
                    ? "font-semibold text-rose-100"
                    : "font-semibold text-rose-700"
                  : null,
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
