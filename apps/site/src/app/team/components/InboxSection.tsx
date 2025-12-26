import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  createThreadAction,
  retryFailedMessageAction,
  sendThreadMessageAction,
  updateThreadAction
} from "../actions";

type ThreadSummary = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  channel: string;
  subject: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  property: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  } | null;
  messageCount: number;
};

type ThreadDetail = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  channel: string;
  subject: string | null;
  lastMessageAt: string | null;
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  property: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  } | null;
};

type MessageDetail = {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  deliveryStatus: string;
  participantName: string | null;
  createdAt: string;
};

type ThreadResponse = {
  thread: ThreadDetail;
  messages: MessageDetail[];
};

type ProviderHealth = {
  provider: "sms" | "email" | "calendar";
  status: "healthy" | "degraded" | "unknown";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
};

type FailedMessage = {
  id: string;
  threadId: string;
  channel: string;
  body: string;
  provider: string | null;
  toAddress: string | null;
  createdAt: string;
  sentAt: string | null;
  failedAt: string | null;
  failureDetail: string | null;
  threadSubject: string | null;
  contact: { id: string; name: string } | null;
};

const THREAD_STATUSES = ["open", "pending", "closed"];
const THREAD_STATES = [
  "new",
  "qualifying",
  "photos_received",
  "estimated",
  "offered_times",
  "booked",
  "reminder",
  "completed",
  "review"
];

function formatStatusLabel(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatStateLabel(value: string): string {
  if (!value) return "";
  return value
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
    .join(" ")
    .trim();
}

function formatProviderLabel(value: ProviderHealth["provider"]): string {
  switch (value) {
    case "sms":
      return "SMS";
    case "email":
      return "Email";
    case "calendar":
      return "Calendar";
    default:
      return value;
  }
}

function formatProviderStatus(value: ProviderHealth["status"]): string {
  switch (value) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Issue";
    default:
      return "Unknown";
  }
}

function providerStatusClasses(value: ProviderHealth["status"]): string {
  switch (value) {
    case "healthy":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "degraded":
      return "border-amber-200 bg-amber-50 text-amber-700";
    default:
      return "border-slate-200 bg-slate-100 text-slate-500";
  }
}

function formatTimestamp(value: string | null): string {
  if (!value) return "No activity yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "No activity yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function formatFailureDetail(detail: string | null): string {
  if (!detail) return "Send failed";
  return detail.replace(/_/g, " ");
}

function getAllowedStates(currentState: string | null | undefined): string[] {
  if (!currentState) return [...THREAD_STATES];
  const index = THREAD_STATES.indexOf(currentState);
  if (index === -1) return [...THREAD_STATES];
  return THREAD_STATES.slice(index);
}

function buildThreadHref(status: string | null, threadId: string): string {
  const params = new URLSearchParams();
  params.set("tab", "inbox");
  if (status) params.set("status", status);
  params.set("threadId", threadId);
  return `/team?${params.toString()}`;
}

type InboxSectionProps = {
  threadId?: string;
  status?: string;
};

export async function InboxSection({ threadId, status }: InboxSectionProps): Promise<React.ReactElement> {
  const activeStatus = status ?? "open";
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (activeStatus !== "all") {
    params.set("status", activeStatus);
  }

  const threadDetailPromise = threadId
    ? callAdminApi(`/api/admin/inbox/threads/${threadId}`)
    : Promise.resolve(null);
  const [threadsRes, providerRes, failedRes, threadDetailRes] = await Promise.all([
    callAdminApi(`/api/admin/inbox/threads?${params.toString()}`),
    callAdminApi("/api/admin/providers/health"),
    callAdminApi("/api/admin/inbox/failed-sends?limit=10"),
    threadDetailPromise
  ]);

  if (!threadsRes.ok) {
    throw new Error("Failed to load inbox threads");
  }

  const threadsPayload = (await threadsRes.json()) as { threads?: ThreadSummary[] };
  const threads = threadsPayload.threads ?? [];

  let providers: ProviderHealth[] = [];
  if (providerRes.ok) {
    const providerPayload = (await providerRes.json()) as { providers?: ProviderHealth[] };
    providers = providerPayload.providers ?? [];
  }

  let failedMessages: FailedMessage[] = [];
  if (failedRes.ok) {
    const failedPayload = (await failedRes.json()) as { messages?: FailedMessage[] };
    failedMessages = failedPayload.messages ?? [];
  }

  let threadDetail: ThreadResponse | null = null;
  if (threadDetailRes) {
    if (threadDetailRes.ok) {
      threadDetail = (await threadDetailRes.json()) as ThreadResponse;
    } else {
      threadDetail = null;
    }
  }

  const activeThread = threadDetail?.thread ?? null;
  const activeMessages = threadDetail?.messages ?? [];
  const allowedStates = activeThread ? getAllowedStates(activeThread.state ?? "new") : [...THREAD_STATES];

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Unified Inbox</h2>
        <p className="mt-1 text-sm text-slate-600">
          Track every lead conversation in one place. Threads show delivery state and keep your team in sync.
        </p>
        {providers.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {providers.map((provider) => {
              const titleParts = [
                provider.lastSuccessAt ? `Last success: ${formatTimestamp(provider.lastSuccessAt)}` : null,
                provider.lastFailureAt ? `Last issue: ${formatTimestamp(provider.lastFailureAt)}` : null,
                provider.lastFailureDetail ? `Detail: ${provider.lastFailureDetail}` : null
              ].filter(Boolean);
              const title = titleParts.length > 0 ? titleParts.join(" • ") : undefined;
              return (
                <span
                  key={provider.provider}
                  title={title}
                  className={`inline-flex items-center rounded-full border px-3 py-1 font-semibold ${providerStatusClasses(
                    provider.status
                  )}`}
                >
                  {formatProviderLabel(provider.provider)} {formatProviderStatus(provider.status)}
                </span>
              );
            })}
          </div>
        ) : null}
      </header>

      <form method="get" className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-600 shadow-md shadow-slate-200/50">
        <input type="hidden" name="tab" value="inbox" />
        <select
          name="status"
          defaultValue={activeStatus}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
        >
          {THREAD_STATUSES.map((value) => (
            <option key={value} value={value}>
              {formatStatusLabel(value)}
            </option>
          ))}
          <option value="all">All</option>
        </select>
        <button
          type="submit"
          className="inline-flex items-center rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
        >
          Filter
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-4 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Threads</h3>
            <span className="text-xs text-slate-500">
              {threads.length} {activeStatus === "all" ? "threads" : activeStatus}
            </span>
          </div>

          {threads.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-sm text-slate-500">
              No threads yet. Create a new conversation below.
            </div>
          ) : (
            <div className="space-y-3">
              {threads.map((thread) => {
                const isActive = thread.id === activeThread?.id;
                return (
                  <a
                    key={thread.id}
                    href={buildThreadHref(activeStatus, thread.id)}
                    className={`block rounded-2xl border px-4 py-3 text-sm transition ${
                      isActive
                        ? "border-primary-300 bg-primary-50/60 shadow-md shadow-primary-100"
                        : "border-slate-200 bg-white hover:border-primary-200 hover:bg-primary-50/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-slate-900">
                        {thread.contact?.name ?? "Unknown contact"}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                          {formatStateLabel(thread.state ?? "new")}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          {thread.channel}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {thread.lastMessagePreview ?? "No messages yet"}
                    </p>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>{formatTimestamp(thread.lastMessageAt)}</span>
                      <span>{thread.messageCount} msg</span>
                    </div>
                  </a>
                );
              })}
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <h4 className="text-sm font-semibold text-slate-900">Start a thread</h4>
            <form action={createThreadAction} className="mt-3 space-y-3">
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                <span>Contact ID</span>
                <input
                  name="contactId"
                  placeholder="Contact UUID"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                <span>Channel</span>
                <select
                  name="channel"
                  defaultValue="sms"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                >
                  {["sms", "email", "dm", "call", "web"].map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                <span>Subject (optional)</span>
                <input
                  name="subject"
                  placeholder="Short summary"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <SubmitButton
                className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Creating..."
              >
                Create thread
              </SubmitButton>
            </form>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-900">Delivery issues</h4>
              <span className="text-xs text-slate-500">{failedMessages.length} failed</span>
            </div>
            {failedMessages.length === 0 ? (
              <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-white/80 p-3 text-xs text-slate-500">
                No failed sends right now.
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {failedMessages.map((message) => (
                  <div key={message.id} className="rounded-2xl border border-slate-200 bg-white p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-slate-900">
                        {message.contact?.name ?? "Unknown contact"}
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {message.channel}
                      </span>
                    </div>
                    <p className="mt-1 text-slate-500">{message.body}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span>{formatFailureDetail(message.failureDetail)}</span>
                      <span>{formatTimestamp(message.failedAt ?? message.createdAt)}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <a
                        href={buildThreadHref("all", message.threadId)}
                        className="text-[11px] font-semibold text-primary-600 hover:text-primary-700"
                      >
                        View thread
                      </a>
                      <form action={retryFailedMessageAction}>
                        <input type="hidden" name="messageId" value={message.id} />
                        <SubmitButton
                          className="rounded-full border border-slate-200 px-3 py-1 text-[11px] text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                          pendingLabel="Retrying..."
                        >
                          Retry send
                        </SubmitButton>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          {activeThread ? (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    {activeThread.contact?.name ?? "Unknown contact"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {activeThread.channel.toUpperCase()} · {formatStatusLabel(activeThread.status)} ·{" "}
                    {formatStateLabel(activeThread.state ?? "new")}
                  </p>
                  {activeThread.stateUpdatedAt ? (
                    <p className="text-[11px] text-slate-400">
                      State updated {formatTimestamp(activeThread.stateUpdatedAt)}
                    </p>
                  ) : null}
                </div>
                <form action={updateThreadAction} className="flex flex-wrap items-center gap-2 text-xs">
                  <input type="hidden" name="threadId" value={activeThread.id} />
                  <select
                    name="state"
                    defaultValue={activeThread.state ?? "new"}
                    className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600"
                  >
                    {allowedStates.map((value) => (
                      <option key={value} value={value}>
                        {formatStateLabel(value)}
                      </option>
                    ))}
                  </select>
                  <select
                    name="status"
                    defaultValue={activeThread.status}
                    className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600"
                  >
                    {THREAD_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {formatStatusLabel(value)}
                      </option>
                    ))}
                  </select>
                  <SubmitButton
                    className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                    pendingLabel="Saving..."
                  >
                    Update thread
                  </SubmitButton>
                </form>
              </div>

              <div className="space-y-3">
                {activeMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-sm text-slate-500">
                    No messages yet. Send the first touch below.
                  </div>
                ) : (
                  activeMessages.map((message) => {
                    const isOutbound = message.direction !== "inbound";
                    return (
                      <div key={message.id} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                            isOutbound ? "bg-primary-100 text-slate-900" : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {message.subject ? (
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              {message.subject}
                            </div>
                          ) : null}
                          <p className="whitespace-pre-wrap">{message.body}</p>
                          <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{message.participantName ?? message.direction}</span>
                            <span>
                              {formatTimestamp(message.createdAt)} - {message.deliveryStatus}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <form action={sendThreadMessageAction} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <input type="hidden" name="threadId" value={activeThread.id} />
                {activeThread.channel === "email" ? (
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    <span>Subject</span>
                    <input
                      name="subject"
                      defaultValue={activeThread.subject ?? ""}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                ) : null}
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span>Message</span>
                  <textarea
                    name="body"
                    rows={3}
                    required
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
                <SubmitButton
                  className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                  pendingLabel="Sending..."
                >
                  Send message
                </SubmitButton>
              </form>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-6 text-sm text-slate-500">
              Select a thread to view the conversation.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
