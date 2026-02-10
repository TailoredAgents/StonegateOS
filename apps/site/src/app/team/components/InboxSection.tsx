import React from "react";
import { redirect } from "next/navigation";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { InboxAutoScroll } from "./InboxAutoScroll";
import { InboxMediaGallery } from "./InboxMediaGallery";
import { TEAM_EMPTY_STATE, TEAM_INPUT_COMPACT, TEAM_SELECT, teamButtonClass } from "./team-ui";
import type { ContactNoteSummary } from "./contacts.types";
import type { ContactReminderSummary } from "./contacts.types";
import { InboxSpeechToTextButtonClient } from "./InboxSpeechToTextButtonClient";
import {
  createThreadAction,
  retryFailedMessageAction,
  sendDraftMessageAction,
  sendThreadMessageAction,
  deleteMessageAction,
  suggestThreadReplyAction,
  updateThreadAction,
  startContactCallAction,
  markSalesTouchAction,
  setSalesDispositionAction
} from "../actions";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";

type ThreadSummary = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  updatedAt?: string | null;
  channel: string;
  subject: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
  assignedTo?: { id: string; name: string } | null;
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
    outOfArea?: boolean | null;
  } | null;
  messageCount: number;
  followup?: {
    state: string | null;
    step: number | null;
    nextAt: string | null;
  } | null;
};

type ThreadDetail = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  channel: string;
  subject: string | null;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
  assignedTo?: { id: string; name: string } | null;
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
    outOfArea?: boolean | null;
  } | null;
};

type MessageDetail = {
  id: string;
  threadId?: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  mediaUrls?: string[];
  deliveryStatus: string;
  participantName: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

type ThreadResponse = {
  thread: ThreadDetail;
  messages: MessageDetail[];
};

type TimelineThread = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  channel: string;
  subject: string | null;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
};

type TimelineResponse = {
  contact: { id: string; name: string; email: string | null; phone: string | null };
  threads: TimelineThread[];
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

function normalizePhoneLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.length ? cleaned : null;
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
    timeZone: TEAM_TIME_ZONE,
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

function splitName(fullName: string): { firstName: string; lastName: string } {
  const normalized = fullName.trim().replace(/\s+/g, " ");
  if (!normalized) return { firstName: "", lastName: "" };
  const parts = normalized.split(" ");
  if (parts.length === 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

function isDmExpired(thread: ThreadSummary, nowMs: number): boolean {
  if (thread.channel !== "dm") return false;
  if (!thread.lastInboundAt) return false;
  const lastInbound = new Date(thread.lastInboundAt);
  if (Number.isNaN(lastInbound.getTime())) return false;
  const elapsedMs = nowMs - lastInbound.getTime();
  return elapsedMs > 24 * 60 * 60 * 1000;
}

function readMetaNumber(meta: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!meta) return null;
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAutoReply(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  return meta["autoReply"] === true;
}

function isDraftMessage(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  return meta["draft"] === true;
}

function getAllowedStates(currentState: string | null | undefined): string[] {
  if (!currentState) return [...THREAD_STATES];
  const index = THREAD_STATES.indexOf(currentState);
  if (index === -1) return [...THREAD_STATES];
  return THREAD_STATES.slice(index);
}

function buildInboxHref(input: {
  status?: string | null;
  threadId?: string | null;
  contactId?: string | null;
  channel?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("tab", "inbox");
  if (input.status) params.set("status", input.status);
  if (input.threadId) params.set("threadId", input.threadId);
  if (input.contactId) params.set("contactId", input.contactId);
  if (input.channel) params.set("channel", input.channel);
  return `/team?${params.toString()}`;
}

type InboxSectionProps = {
  threadId?: string;
  status?: string;
  contactId?: string;
  channel?: string;
};

function isSupportedChannel(value: string | null | undefined): value is "sms" | "email" | "dm" {
  return value === "sms" || value === "email" || value === "dm";
}

export async function InboxSection({ threadId, status, contactId, channel }: InboxSectionProps): Promise<React.ReactElement> {
  const activeStatus = status ?? "open";
  const requestedChannel = isSupportedChannel(channel) ? channel : "sms";

  const params = new URLSearchParams();
  params.set("limit", "50");
  if (activeStatus !== "all") {
    params.set("status", activeStatus);
  }

  const threadDetailPromise = threadId
    ? callAdminApi(`/api/admin/inbox/threads/${threadId}`).catch(() => null)
    : Promise.resolve(null);

  const [threadsRes, providerRes, failedRes, threadDetailRes] = await Promise.all([
    callAdminApi(`/api/admin/inbox/threads?${params.toString()}`).catch(() => null),
    callAdminApi("/api/admin/providers/health").catch(() => null),
    callAdminApi("/api/admin/inbox/failed-sends?limit=10").catch(() => null),
    threadDetailPromise
  ]);

  let threadsError: { message: string; status?: number } | null = null;

  let threads: ThreadSummary[] = [];
  if (!threadsRes) {
    threadsError = { message: "Unable to reach the API service for inbox threads." };
  } else if (!threadsRes.ok) {
    const detail = await threadsRes.text().catch(() => "");
    threadsError = {
      message: detail.trim().length ? detail.trim() : "Failed to load inbox threads.",
      status: threadsRes.status
    };
  } else {
    const threadsPayload = (await threadsRes.json()) as { threads?: ThreadSummary[] };
    threads = threadsPayload.threads ?? [];
  }

  let providers: ProviderHealth[] = [];
  if (providerRes?.ok) {
    const providerPayload = (await providerRes.json()) as { providers?: ProviderHealth[] };
    providers = providerPayload.providers ?? [];
  }

  let failedMessages: FailedMessage[] = [];
  if (failedRes?.ok) {
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
  const activeThreadMessages = threadDetail?.messages ?? [];
  const requestedContactId = typeof contactId === "string" && contactId.trim().length ? contactId.trim() : null;
  const activeContactId = requestedContactId ?? activeThread?.contact?.id ?? null;

  let timeline: TimelineResponse | null = null;
  if (activeContactId) {
    try {
      const res = await callAdminApi(`/api/admin/inbox/timeline?contactId=${encodeURIComponent(activeContactId)}&limit=300`);
      if (res.ok) {
        timeline = (await res.json().catch(() => null)) as TimelineResponse | null;
      }
    } catch {
      timeline = null;
    }
  }

  const activeContact = timeline?.contact ?? activeThread?.contact ?? null;
  const timelineThreads = timeline?.threads ?? [];
  const timelineMessages = timeline?.messages?.length ? timeline.messages : activeThreadMessages;

  let activeContactSummary:
    | {
        pipeline?: { stage: string; notes: string | null };
        stats?: { appointments: number; quotes: number };
        lastActivityAt?: string | null;
      }
    | null = null;
  if (activeContactId) {
    try {
      const res = await callAdminApi(`/api/admin/contacts?contactId=${encodeURIComponent(activeContactId)}&limit=1`);
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as unknown;
        const contactsPayload =
          data && typeof data === "object" ? (data as Record<string, unknown>)["contacts"] : null;
        if (Array.isArray(contactsPayload) && contactsPayload.length > 0) {
          const first = contactsPayload[0];
          if (first && typeof first === "object") {
            const record = first as Record<string, unknown>;
            const pipelineRaw = record["pipeline"];
            const statsRaw = record["stats"];
            const lastActivityAt = typeof record["lastActivityAt"] === "string" ? record["lastActivityAt"] : null;

            const stage =
              pipelineRaw && typeof pipelineRaw === "object" && typeof (pipelineRaw as Record<string, unknown>)["stage"] === "string"
                ? String((pipelineRaw as Record<string, unknown>)["stage"])
                : null;
            const pipelineNotes =
              pipelineRaw && typeof pipelineRaw === "object" && typeof (pipelineRaw as Record<string, unknown>)["notes"] === "string"
                ? String((pipelineRaw as Record<string, unknown>)["notes"])
                : null;

            const appts =
              statsRaw && typeof statsRaw === "object" && typeof (statsRaw as Record<string, unknown>)["appointments"] === "number"
                ? Number((statsRaw as Record<string, unknown>)["appointments"])
                : null;
            const quotesCount =
              statsRaw && typeof statsRaw === "object" && typeof (statsRaw as Record<string, unknown>)["quotes"] === "number"
                ? Number((statsRaw as Record<string, unknown>)["quotes"])
                : null;

            activeContactSummary = {
              pipeline: stage ? { stage, notes: pipelineNotes } : undefined,
              stats: appts !== null && quotesCount !== null ? { appointments: appts, quotes: quotesCount } : undefined,
              lastActivityAt
            };
          }
        }
      }
    } catch {
      activeContactSummary = null;
    }
  }

  let contactReminders: ContactReminderSummary[] = [];
  let contactNotes: ContactNoteSummary[] = [];
  if (activeContactId) {
    try {
      const [openRes, completedRes] = await Promise.all([
        callAdminApi(`/api/admin/crm/tasks?contactId=${encodeURIComponent(activeContactId)}&status=open`),
        callAdminApi(`/api/admin/crm/tasks?contactId=${encodeURIComponent(activeContactId)}&status=completed`)
      ]);

      const parseTasks = async (res: Response): Promise<Array<Record<string, unknown>>> => {
        if (!res.ok) return [];
        const data = (await res.json().catch(() => null)) as unknown;
        const tasks = data && typeof data === "object" ? (data as Record<string, unknown>)["tasks"] : null;
        return Array.isArray(tasks) ? (tasks as Array<Record<string, unknown>>) : [];
      };

      const isSystemReminder = (title: string, notes: string | null): boolean => {
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.startsWith("auto:")) return true;
        const lowerNotes = (notes ?? "").toLowerCase();
        return lowerNotes.includes("kind=speed_to_lead") || lowerNotes.includes("kind=follow_up") || lowerNotes.includes("[auto]");
      };

      const openTasks = await parseTasks(openRes);
      contactReminders = openTasks
        .map((task) => {
          if (!task || typeof task !== "object") return null;
          const id = typeof task["id"] === "string" ? (task["id"] as string) : null;
          const title = typeof task["title"] === "string" ? (task["title"] as string) : null;
          const dueAt = typeof task["dueAt"] === "string" ? (task["dueAt"] as string) : null;
          const assignedTo = typeof task["assignedTo"] === "string" ? (task["assignedTo"] as string) : null;
          const status = task["status"] === "completed" ? "completed" : "open";
          const createdAt = typeof task["createdAt"] === "string" ? (task["createdAt"] as string) : null;
          const updatedAt = typeof task["updatedAt"] === "string" ? (task["updatedAt"] as string) : null;
          const notes = typeof task["notes"] === "string" ? (task["notes"] as string) : null;
          if (!id || !title || !createdAt || !updatedAt) return null;
          if (status !== "open") return null;
          if (isSystemReminder(title, notes)) return null;
          return {
            id,
            title,
            notes,
            dueAt,
            assignedTo,
            status: "open",
            createdAt,
            updatedAt
          } satisfies ContactReminderSummary;
        })
        .filter(Boolean)
        .slice(0, 25) as ContactReminderSummary[];

      const completedTasks = await parseTasks(completedRes);
      contactNotes = completedTasks
        .map((task) => {
          if (!task || typeof task !== "object") return null;
          const id = typeof task["id"] === "string" ? (task["id"] as string) : null;
          const body = typeof task["notes"] === "string" ? (task["notes"] as string) : null;
          const createdAt = typeof task["createdAt"] === "string" ? (task["createdAt"] as string) : null;
          const updatedAt = typeof task["updatedAt"] === "string" ? (task["updatedAt"] as string) : null;
          if (!id || !body || !createdAt || !updatedAt) return null;
          const normalized = body.trim();
          if (!normalized) return null;
          return { id, body: normalized, createdAt, updatedAt } satisfies ContactNoteSummary;
        })
        .filter(Boolean)
        .slice(0, 25) as ContactNoteSummary[];
    } catch {
      contactReminders = [];
      contactNotes = [];
    }
  }

  const channelThreadMap = new Map<string, string>();
  for (const t of timelineThreads) {
    if (!t?.channel || !t?.id) continue;
    if (!channelThreadMap.has(t.channel)) channelThreadMap.set(t.channel, t.id);
  }

  const activeChannelThreadId = activeContactId ? (channelThreadMap.get(requestedChannel) ?? null) : null;
  const selectedThreadId =
    activeChannelThreadId ?? (activeThread?.id && activeThread.channel === requestedChannel ? activeThread.id : null);
  const selectedThread = selectedThreadId
    ? timelineThreads.find((t) => t.id === selectedThreadId) ?? (activeThread?.id === selectedThreadId ? activeThread : null)
    : null;

  const selectedThreadState = (selectedThread as { state?: string | null } | null)?.state ?? "new";
  const allowedStates = selectedThread ? getAllowedStates(selectedThreadState) : [...THREAD_STATES];
  const activeThreadSummary =
    activeContactId && threads.length
      ? threads.find((t) => t.contact?.id === activeContactId && t.channel === requestedChannel) ??
        threads.find((t) => t.contact?.id === activeContactId) ??
        null
      : null;
  const activeProperty = activeThread?.property ?? activeThreadSummary?.property ?? null;
  const activePhone = normalizePhoneLink(activeContact?.phone);
  const canCall = Boolean(activeContactId && activePhone);
  const showConversation = Boolean(activeContactId);
  const scrollKey = (() => {
    const lastId = timelineMessages.length ? timelineMessages[timelineMessages.length - 1]?.id ?? "none" : "none";
    return `${selectedThreadId ?? "none"}:${timelineMessages.length}:${lastId}`;
  })();

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Unified Inbox</h2>
        <p className="mt-1 text-sm text-slate-600">
          Track every lead conversation in one place. Threads show delivery state and keep your team in sync.
        </p>
        {threadsError ? (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">Inbox unavailable</p>
            <p className="mt-1">{threadsError.message}</p>
            {threadsError.status === 401 || threadsError.status === 403 ? (
              <p className="mt-2 text-xs text-amber-800">
                Check that the Site and API services share the same `ADMIN_API_KEY` and that the account role has `messages.read`.
              </p>
            ) : null}
          </div>
        ) : null}
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

      <form
        method="get"
        className={`flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-600 shadow-md shadow-slate-200/50 ${
          showConversation ? "hidden lg:flex" : ""
        }`}
      >
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
          className={teamButtonClass("secondary")}
        >
          Filter
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)_340px] xl:grid-cols-[400px_minmax(0,1fr)_380px]">
        <div
          className={`space-y-4 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-xl shadow-slate-200/50 backdrop-blur ${
            showConversation ? "hidden lg:block" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Threads</h3>
            <span className="text-xs text-slate-500">
              {threads.length} {activeStatus === "all" ? "threads" : activeStatus}
            </span>
          </div>

          {threads.length === 0 ? (
            <div className={TEAM_EMPTY_STATE}>
              No threads yet. Create a new conversation below.
            </div>
          ) : (
            <div className="space-y-3">
              {(() => {
                const nowMs = Date.now();
                type ContactGroup = {
                  key: string;
                  contactId: string | null;
                  name: string;
                  threads: ThreadSummary[];
                  lastActivityAt: string | null;
                  lastPreview: string | null;
                  outOfArea: boolean;
                  followupNextAt: string | null;
                  followupRunning: boolean;
                  expired: boolean;
                  messageCount: number;
                };

                const getThreadActivityAt = (thread: ThreadSummary): string | null => {
                  return thread.lastMessageAt ?? thread.lastInboundAt ?? thread.stateUpdatedAt ?? thread.updatedAt ?? null;
                };

                const byKey = new Map<string, ContactGroup>();
                for (const thread of threads) {
                  const contactId = thread.contact?.id ?? null;
                  const key = contactId ?? `thread:${thread.id}`;
                  const existing = byKey.get(key);
                  const threadName = thread.contact?.name ?? "Unknown contact";
                  const threadActivityAt = getThreadActivityAt(thread);
                  const parsedLast = threadActivityAt ? Date.parse(threadActivityAt) : NaN;
                  const parsedExisting = existing?.lastActivityAt ? Date.parse(existing.lastActivityAt) : NaN;
                  const isNewer =
                    Number.isFinite(parsedLast) &&
                    (!Number.isFinite(parsedExisting) || parsedLast > parsedExisting);

                  const expired = isDmExpired(thread, nowMs);
                  const followupRunning = Boolean(thread.followup?.nextAt && thread.followup.state === "running");
                  const followupNextAt = followupRunning ? thread.followup!.nextAt : null;

                  if (!existing) {
                    byKey.set(key, {
                      key,
                      contactId,
                      name: threadName,
                      threads: [thread],
                      lastActivityAt: threadActivityAt,
                      lastPreview: thread.lastMessagePreview ?? null,
                      outOfArea: Boolean(thread.property?.outOfArea),
                      followupNextAt,
                      followupRunning,
                      expired,
                      messageCount: thread.messageCount ?? 0
                    });
                    continue;
                  }

                  existing.threads.push(thread);
                  existing.messageCount += thread.messageCount ?? 0;
                  existing.outOfArea = existing.outOfArea || Boolean(thread.property?.outOfArea);
                  existing.expired = existing.expired || expired;

                  if (followupRunning) {
                    if (!existing.followupNextAt) {
                      existing.followupNextAt = followupNextAt;
                      existing.followupRunning = true;
                    } else {
                      const a = Date.parse(existing.followupNextAt);
                      const b = Date.parse(followupNextAt ?? "");
                      if (Number.isFinite(b) && (!Number.isFinite(a) || b < a)) {
                        existing.followupNextAt = followupNextAt;
                        existing.followupRunning = true;
                      }
                    }
                  }

                  if (isNewer) {
                    existing.lastActivityAt = threadActivityAt;
                    existing.lastPreview =
                      (typeof thread.lastMessagePreview === "string" && thread.lastMessagePreview.trim().length > 0
                        ? thread.lastMessagePreview
                        : null) ?? existing.lastPreview;
                    existing.name = threadName || existing.name;
                  }
                }

                const groups = Array.from(byKey.values()).sort((a, b) => {
                  const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
                  const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
                  if (aTime !== bTime) return bTime - aTime;
                  return a.name.localeCompare(b.name);
                });

                return groups.map((group) => {
                  const isActive = Boolean(group.contactId && activeContactId) && group.contactId === activeContactId;

                  const sortedThreads = [...group.threads].sort((a, b) => {
                    const aAt = getThreadActivityAt(a);
                    const bAt = getThreadActivityAt(b);
                    const aTime = aAt ? Date.parse(aAt) : 0;
                    const bTime = bAt ? Date.parse(bAt) : 0;
                    if (aTime !== bTime) return bTime - aTime;
                    return a.channel.localeCompare(b.channel);
                  });

                  const availableChannels = new Set(sortedThreads.map((t) => t.channel));
                  const landingChannel = availableChannels.has(requestedChannel)
                    ? requestedChannel
                    : (sortedThreads[0]?.channel ?? requestedChannel);

                  const groupHref = group.contactId
                    ? buildInboxHref({
                        status: activeStatus === "all" ? null : activeStatus,
                        contactId: group.contactId,
                        channel: landingChannel
                      })
                    : buildInboxHref({
                        status: activeStatus === "all" ? null : activeStatus,
                        threadId: group.threads[0]?.id ?? null
                      });

                  return (
                    <div
                      key={group.key}
                      className={`rounded-2xl border px-4 py-3 text-sm transition ${
                        isActive
                          ? "border-primary-300 bg-primary-50/60 shadow-md shadow-primary-100"
                          : "border-slate-200 bg-white hover:border-primary-200 hover:bg-primary-50/30"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <a href={groupHref} className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-slate-900">{group.name}</div>
                        </a>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {group.outOfArea ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                              Out of area
                            </span>
                          ) : null}
                          {group.followupRunning && group.followupNextAt ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              Follow-up {formatTimestamp(group.followupNextAt)}
                            </span>
                          ) : null}
                          {group.expired ? (
                            <span
                              className="inline-flex items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                              title="At least one Messenger thread has expired; please message directly in Messenger or wait for the customer to reply."
                            >
                              expired
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <p className="mt-1 text-xs text-slate-500">{group.lastPreview ?? "No messages yet"}</p>

                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span>{formatTimestamp(group.lastActivityAt)}</span>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {sortedThreads.map((t) => {
                            const href = t.contact?.id
                              ? buildInboxHref({
                                  status: activeStatus === "all" ? null : activeStatus,
                                  contactId: t.contact.id,
                                  channel: t.channel
                                })
                              : buildInboxHref({
                                  status: activeStatus === "all" ? null : activeStatus,
                                  threadId: t.id
                                });
                            const isChannelActive = isActive && t.channel === requestedChannel;
                            return (
                              <a
                                key={t.id}
                                href={href}
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                  isChannelActive
                                    ? "border-primary-300 bg-primary-100 text-primary-800"
                                    : "border-slate-200 bg-slate-50 text-slate-600 hover:border-primary-200 hover:text-primary-700"
                                }`}
                                title={`${t.channel.toUpperCase()} thread`}
                              >
                                {t.channel}
                              </a>
                            );
                          })}
                          <span className="ml-1">{group.messageCount} msg</span>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
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
                  className={TEAM_INPUT_COMPACT}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                <span>Channel</span>
                <select
                  name="channel"
                  defaultValue="sms"
                  className={TEAM_SELECT}
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
                  className={TEAM_INPUT_COMPACT}
                />
              </label>
              <SubmitButton
                className={teamButtonClass("primary", "sm")}
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
                        href={buildInboxHref({ status: "all", threadId: message.threadId })}
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

        <div
          className={`rounded-3xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/50 backdrop-blur ${
            showConversation ? "" : "hidden lg:block"
          }`}
        >
          {activeContactId ? (
            <div className="flex max-h-none flex-col gap-4 overflow-hidden p-5 lg:max-h-[78dvh]">
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <a
                    href={buildInboxHref({ status: activeStatus === "all" ? null : activeStatus })}
                    className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-primary-700 lg:hidden"
                  >
                    <span aria-hidden>←</span> Threads
                  </a>
                  <h3 className="text-lg font-semibold text-slate-900">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span>{activeContact?.name ?? "Unknown contact"}</span>
                      {activeContactId ? (
                        <ContactNameEditorClient contactId={activeContactId} contactName={activeContact?.name ?? ""} />
                      ) : null}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    {(requestedChannel === "dm" ? "Messenger" : requestedChannel.toUpperCase())}{" "}
                    {selectedThread
                      ? `| ${formatStatusLabel((selectedThread as { status: string }).status)} | ${formatStateLabel(
                          (selectedThread as { state?: string | null }).state ?? "new"
                        )}`
                      : "| No thread yet"}
                  </p>
                  {activeProperty?.outOfArea ? (
                    <p className="mt-1 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                      Out of area
                    </p>
                  ) : null}
                  {(selectedThread as { stateUpdatedAt?: string | null } | null)?.stateUpdatedAt ? (
                    <p className="text-[11px] text-slate-400">
                      State updated {formatTimestamp((selectedThread as { stateUpdatedAt: string }).stateUpdatedAt)}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2 lg:hidden">
                  {activeContactId ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {(["sms", "dm", "email"] as const).map((ch) => {
                        const isActive = requestedChannel === ch;
                        const existingId = channelThreadMap.get(ch) ?? null;
                        const hasPhone = Boolean(activeContact?.phone);
                        const hasEmail = Boolean(activeContact?.email);
                        const disabled =
                          ch === "dm"
                            ? !existingId
                            : ch === "sms"
                              ? !hasPhone
                              : ch === "email"
                                ? !hasEmail
                                : false;

                        const label = ch === "dm" ? "Messenger" : ch.toUpperCase();
                        const href = buildInboxHref({
                          status: activeStatus === "all" ? null : activeStatus,
                          contactId: activeContactId,
                          channel: ch
                        });

                        return (
                          <a
                            key={ch}
                            href={disabled ? "#" : href}
                            className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${
                              isActive
                                ? "border-primary-300 bg-primary-50 text-primary-800"
                                : "border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-700"
                            } ${disabled ? "pointer-events-none opacity-40" : ""}`}
                            title={
                              disabled
                                ? ch === "dm"
                                  ? "No Messenger thread yet"
                                  : ch === "sms"
                                    ? "No phone number on file"
                                    : "No email on file"
                                : undefined
                            }
                          >
                            {label}
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <form action={startContactCallAction} className="inline">
                      <input type="hidden" name="contactId" value={activeContactId ?? ""} />
                      <SubmitButton
                        className={`rounded-full border px-3 py-2 text-xs font-semibold ${
                          canCall
                            ? "border-slate-200 text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                            : "pointer-events-none border-slate-100 text-slate-300"
                        }`}
                        disabled={!canCall}
                        pendingLabel="Calling..."
                      >
                        Call
                      </SubmitButton>
                    </form>
                    {activeContactId ? (
                      <form action={markSalesTouchAction} className="inline">
                        <input type="hidden" name="contactId" value={activeContactId} />
                        <SubmitButton
                          className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                          pendingLabel="Saving..."
                        >
                          Mark contacted
                        </SubmitButton>
                      </form>
                    ) : null}
                    {activeContactId ? (
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700">
                          Remove
                        </summary>
                        <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
                          <form action={setSalesDispositionAction} className="space-y-2">
                            <input type="hidden" name="contactId" value={activeContactId} />
                            <select
                              name="disposition"
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                              defaultValue="handled"
                            >
                              <option value="spam">Spam</option>
                              <option value="not_a_lead">Not a lead</option>
                              <option value="out_of_state">Out of state</option>
                              <option value="out_of_area">Out of area</option>
                              <option value="bad_phone">Bad phone</option>
                              <option value="duplicate">Duplicate</option>
                              <option value="handled">Handled</option>
                              <option value="do_not_contact">Do not contact</option>
                            </select>
                            <SubmitButton
                              className="w-full rounded-full bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                              pendingLabel="Removing..."
                            >
                              Confirm remove
                            </SubmitButton>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </div>
                  {selectedThreadId ? (
                    <form action={updateThreadAction} className="flex flex-wrap items-center gap-2 text-xs">
                      <input type="hidden" name="threadId" value={selectedThreadId} />
                      <select
                        name="state"
                        defaultValue={(selectedThread as { state?: string | null } | null)?.state ?? "new"}
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
                        defaultValue={(selectedThread as { status?: string } | null)?.status ?? "open"}
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
                  ) : (
                    <div className="text-xs text-slate-400">No {requestedChannel === "dm" ? "Messenger" : requestedChannel.toUpperCase()} thread yet.</div>
                  )}
                </div>
              </div>

              <div id="inbox-thread-scroll" className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {timelineMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-sm text-slate-500">
                    No messages yet. Send the first touch below.
                  </div>
                ) : (
                  timelineMessages.map((message) => {
                    const isOutbound = message.direction !== "inbound";
                    const autoReply = isAutoReply(message.metadata ?? null);
                    const autoReplyDelayMs = readMetaNumber(message.metadata ?? null, "autoReplyDelayMs");
                    const isDraft = isDraftMessage(message.metadata ?? null);
                    const statusLabel = isDraft ? "draft" : message.deliveryStatus;
                    const hasMedia = Array.isArray(message.mediaUrls) && message.mediaUrls.length > 0;
                    const trimmedBody = typeof message.body === "string" ? message.body.trim() : "";
                    const showBody = trimmedBody.length > 0 && !(hasMedia && trimmedBody === "Media message");
                    return (
                      <div key={message.id} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm lg:max-w-[640px] ${
                            isOutbound ? "bg-primary-100 text-slate-900" : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {autoReply ? (
                                <div className="inline-flex items-center gap-2 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                                  Auto reply
                                  {typeof autoReplyDelayMs === "number"
                                    ? `(${Math.round(autoReplyDelayMs / 1000)}s delay)`
                                    : null}
                                </div>
                              ) : null}
                              {isDraft ? (
                                <div className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                  Draft
                                </div>
                              ) : null}
                              <div className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                                {message.channel === "dm" ? "Messenger" : message.channel.toUpperCase()}
                              </div>
                            </div>
                            <form action={deleteMessageAction}>
                              <input type="hidden" name="messageId" value={message.id} />
                              <button
                                type="submit"
                                className="text-[12px] text-slate-500 transition hover:text-rose-600"
                                title="Delete message"
                                aria-label="Delete message"
                              >
                                X
                              </button>
                            </form>
                          </div>
                          {message.subject ? (
                            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              {message.subject}
                            </div>
                          ) : null}
                          {showBody ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
                          {hasMedia ? <InboxMediaGallery messageId={message.id} count={message.mediaUrls!.length} /> : null}
                          <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                            <span>{message.participantName ?? message.direction}</span>
                            <span>
                              {formatTimestamp(message.createdAt)} - {statusLabel}
                            </span>
                          </div>
                          {isOutbound && isDraft ? (
                            <div className="mt-3 flex justify-end">
                              <form action={sendDraftMessageAction}>
                                <input type="hidden" name="messageId" value={message.id} />
                                <SubmitButton
                                  className="rounded-full bg-primary-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow transition hover:bg-primary-700"
                                  pendingLabel="Sending..."
                                >
                                  Send
                                </SubmitButton>
                              </form>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
                <div id="inbox-thread-bottom" />
                <InboxAutoScroll containerId="inbox-thread-scroll" bottomId="inbox-thread-bottom" depsKey={scrollKey} />
              </div>

              <div className="-mx-5 relative z-10 border-t border-slate-200 bg-white/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur">
                <form action={suggestThreadReplyAction} className="flex justify-end gap-2">
                  <input type="hidden" name="contactId" value={activeContactId} />
                  <input type="hidden" name="channel" value={requestedChannel} />
                  {selectedThreadId ? <input type="hidden" name="threadId" value={selectedThreadId} /> : null}
                  <SubmitButton
                    className={teamButtonClass("secondary", "sm")}
                    pendingLabel="Thinking..."
                    disabled={
                      requestedChannel === "dm"
                        ? !channelThreadMap.get("dm")
                        : requestedChannel === "sms"
                          ? !activeContact?.phone
                          : requestedChannel === "email"
                            ? !activeContact?.email
                            : false
                    }
                  >
                    AI Suggest
                  </SubmitButton>
                </form>

                <form
                  action={sendThreadMessageAction}
                  method="post"
                  encType="multipart/form-data"
                  className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
                >
                  <input type="hidden" name="contactId" value={activeContactId} />
                  <input type="hidden" name="channel" value={requestedChannel} />
                  {selectedThreadId ? <input type="hidden" name="threadId" value={selectedThreadId} /> : null}
                  {requestedChannel === "email" ? (
                    <label className="flex flex-col gap-1 text-xs text-slate-600">
                      <span>Subject</span>
                      <input
                        name="subject"
                        defaultValue={(selectedThread as { subject?: string | null } | null)?.subject ?? ""}
                        className={TEAM_INPUT_COMPACT}
                      />
                    </label>
                  ) : null}
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    <span className="flex items-center justify-between gap-3">
                      <span>Message</span>
                      <InboxSpeechToTextButtonClient textareaId="inbox-thread-body" />
                    </span>
                    <textarea id="inbox-thread-body" name="body" rows={3} className={TEAM_INPUT_COMPACT} />
                  </label>
                  {requestedChannel === "sms" || requestedChannel === "dm" ? (
                    <label className="flex flex-col gap-1 text-xs text-slate-600">
                      <span>Attach photos (optional)</span>
                      <input
                        type="file"
                        name="attachments"
                        accept="image/*,video/*"
                        multiple
                        className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"
                      />
                      <span className="text-[11px] text-slate-500">You can send photos with or without text.</span>
                    </label>
                  ) : null}
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Sending..."
                    disabled={
                      requestedChannel === "dm"
                        ? !channelThreadMap.get("dm")
                        : requestedChannel === "sms"
                          ? !activeContact?.phone
                          : requestedChannel === "email"
                            ? !activeContact?.email
                            : false
                    }
                  >
                    Send message
                  </SubmitButton>
                </form>
              </div>
            </div>
          ) : (
            <div className="p-5">
              <div className={TEAM_EMPTY_STATE}>Select a thread to view the conversation.</div>
            </div>
          )}
        </div>

        <div className="hidden rounded-3xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/50 backdrop-blur lg:block">
          <div className="flex max-h-[78dvh] flex-col gap-4 overflow-hidden p-5">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">Details</h3>
                <p className="mt-1 text-xs text-slate-500">Keep context handy while you reply.</p>
              </div>
            </div>

            {activeContactId ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold text-slate-900">
                          {activeContact?.name ?? "Unknown contact"}
                        </div>
                        <ContactNameEditorClient contactId={activeContactId} contactName={activeContact?.name ?? ""} />
                      </div>
                      <div className="mt-1 space-y-1 text-xs text-slate-600">
                        {activeContact?.phone ? (
                          <div>Phone: {activeContact.phone}</div>
                        ) : (
                          <div className="text-slate-400">Phone: not on file</div>
                        )}
                        {activeContact?.email ? (
                          <div>Email: {activeContact.email}</div>
                        ) : (
                          <div className="text-slate-400">Email: not on file</div>
                        )}
                        {activeThreadSummary?.assignedTo?.name ? (
                          <div>Assigned to: {activeThreadSummary.assignedTo.name}</div>
                        ) : null}
                        {activeContactSummary?.pipeline?.stage ? (
                          <div>Stage: {activeContactSummary.pipeline.stage}</div>
                        ) : null}
                        {activeContactSummary?.stats ? (
                          <div>
                            Appointments: {activeContactSummary.stats.appointments} • Quotes: {activeContactSummary.stats.quotes}
                          </div>
                        ) : null}
                        {activeContactSummary?.lastActivityAt ? (
                          <div>Last activity: {formatTimestamp(activeContactSummary.lastActivityAt)}</div>
                        ) : null}
                      </div>
                    </div>
                    {activeProperty?.outOfArea ? (
                      <span className="shrink-0 rounded-full bg-rose-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                        Out of area
                      </span>
                    ) : null}
                  </div>

                  {activeProperty ? (
                    <div className="mt-3 border-t border-slate-200/70 pt-3 text-xs text-slate-600">
                      <div className="font-semibold text-slate-700">Address</div>
                      <div className="mt-1">
                        {activeProperty.addressLine1}
                        <div className="text-slate-500">
                          {activeProperty.city}, {activeProperty.state} {activeProperty.postalCode}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <InboxContactRemindersClient contactId={activeContactId} initialReminders={contactReminders} />

                <InboxContactNotesClient contactId={activeContactId} initialNotes={contactNotes} />

                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Channels</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {(["sms", "dm", "email"] as const).map((ch) => {
                      const isActive = requestedChannel === ch;
                      const existingId = channelThreadMap.get(ch) ?? null;
                      const hasPhone = Boolean(activeContact?.phone);
                      const hasEmail = Boolean(activeContact?.email);
                      const disabled =
                        ch === "dm"
                          ? !existingId
                          : ch === "sms"
                            ? !hasPhone
                            : ch === "email"
                              ? !hasEmail
                              : false;

                      const label = ch === "dm" ? "Messenger" : ch.toUpperCase();
                      const href = buildInboxHref({
                        status: activeStatus === "all" ? null : activeStatus,
                        contactId: activeContactId,
                        channel: ch
                      });

                      return (
                        <a
                          key={ch}
                          href={disabled ? "#" : href}
                          className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${
                            isActive
                              ? "border-primary-300 bg-primary-50 text-primary-800"
                              : "border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-700"
                          } ${disabled ? "pointer-events-none opacity-40" : ""}`}
                          title={
                            disabled
                              ? ch === "dm"
                                ? "No Messenger thread yet"
                                : ch === "sms"
                                  ? "No phone number on file"
                                  : "No email on file"
                              : undefined
                          }
                        >
                          {label}
                        </a>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <form action={startContactCallAction} method="post" className="inline">
                      <input type="hidden" name="contactId" value={activeContactId ?? ""} />
                      <SubmitButton
                        className={`rounded-full border px-3 py-2 text-xs font-semibold ${
                          canCall
                            ? "border-slate-200 text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                            : "pointer-events-none border-slate-100 text-slate-300"
                        }`}
                        disabled={!canCall}
                        pendingLabel="Calling..."
                      >
                        Call
                      </SubmitButton>
                    </form>
                    <form action={markSalesTouchAction} className="inline">
                      <input type="hidden" name="contactId" value={activeContactId} />
                      <SubmitButton
                        className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                        pendingLabel="Saving..."
                      >
                        Mark contacted
                      </SubmitButton>
                    </form>
                    <details className="relative">
                      <summary className="cursor-pointer list-none rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700">
                        Remove
                      </summary>
                      <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
                        <form action={setSalesDispositionAction} className="space-y-2">
                          <input type="hidden" name="contactId" value={activeContactId} />
                          <select
                            name="disposition"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                            defaultValue="handled"
                          >
                            <option value="spam">Spam</option>
                            <option value="not_a_lead">Not a lead</option>
                            <option value="out_of_state">Out of state</option>
                            <option value="out_of_area">Out of area</option>
                            <option value="bad_phone">Bad phone</option>
                            <option value="duplicate">Duplicate</option>
                            <option value="handled">Handled</option>
                            <option value="do_not_contact">Do not contact</option>
                          </select>
                          <SubmitButton
                            className="w-full rounded-full bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                            pendingLabel="Removing..."
                          >
                            Confirm remove
                          </SubmitButton>
                        </form>
                      </div>
                    </details>
                  </div>
                </div>

                {selectedThreadId ? (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Thread status</div>
                    <form action={updateThreadAction} className="flex flex-wrap items-center gap-2 text-xs">
                      <input type="hidden" name="threadId" value={selectedThreadId} />
                      <select
                        name="state"
                        defaultValue={(selectedThread as { state?: string | null } | null)?.state ?? "new"}
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
                        defaultValue={(selectedThread as { status?: string } | null)?.status ?? "open"}
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
                        Update
                      </SubmitButton>
                    </form>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4 text-xs text-slate-500">
                    No {requestedChannel === "dm" ? "Messenger" : requestedChannel.toUpperCase()} thread yet.
                  </div>
                )}
              </div>
            ) : (
              <div className="p-5">
                <div className={TEAM_EMPTY_STATE}>Select a thread to see details.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
