import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { createThreadAction, sendThreadMessageAction, updateThreadAction } from "../actions";

type ThreadSummary = {
  id: string;
  status: string;
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

const THREAD_STATUSES = ["open", "pending", "closed"];

function formatStatusLabel(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
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

  const threadsRes = await callAdminApi(`/api/admin/inbox/threads?${params.toString()}`);
  const threadDetailRes = threadId ? await callAdminApi(`/api/admin/inbox/threads/${threadId}`) : null;

  if (!threadsRes.ok) {
    throw new Error("Failed to load inbox threads");
  }

  const threadsPayload = (await threadsRes.json()) as { threads?: ThreadSummary[] };
  const threads = threadsPayload.threads ?? [];

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

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Unified Inbox</h2>
        <p className="mt-1 text-sm text-slate-600">
          Track every lead conversation in one place. Threads show delivery state and keep your team in sync.
        </p>
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
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {thread.channel}
                      </span>
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
                    {activeThread.channel.toUpperCase()} - {activeThread.status}
                  </p>
                </div>
                <form action={updateThreadAction} className="flex flex-wrap items-center gap-2 text-xs">
                  <input type="hidden" name="threadId" value={activeThread.id} />
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
                    Update status
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
