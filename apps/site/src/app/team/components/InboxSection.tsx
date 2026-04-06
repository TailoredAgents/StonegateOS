import React from "react";
import { redirect } from "next/navigation";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { InboxAutoScroll } from "./InboxAutoScroll";
import { InboxAutoDraftClient } from "./InboxAutoDraftClient";
import { InboxMediaGallery } from "./InboxMediaGallery";
import { InboxLiveUpdatesClient } from "./InboxLiveUpdatesClient";
import { TEAM_EMPTY_STATE, TEAM_INPUT_COMPACT, TEAM_SELECT, teamButtonClass } from "./team-ui";
import type { ContactNoteSummary } from "./contacts.types";
import type { ContactReminderSummary } from "./contacts.types";
import { InboxSpeechToTextButtonClient } from "./InboxSpeechToTextButtonClient";
import {
  createThreadAction,
  retryFailedMessageAction,
  sendDraftMessageAction,
  sendThreadMessageAction,
  suggestThreadReplyAction,
  deleteMessageAction,
  updateThreadAction,
  startContactCallAction,
  markSalesTouchAction,
  setSalesDispositionAction
} from "../actions";
import { ContactNameEditorClient } from "./ContactNameEditorClient";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import { ContactMediaAnalysisClient } from "./ContactMediaAnalysisClient";
import { ContactSalesAgentMemoryClient } from "./ContactSalesAgentMemoryClient";
import { ContactSalesAgentNextActionClient } from "./ContactSalesAgentNextActionClient";

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

type NextActionSummaryResponse = {
  ok?: boolean;
  nextAction?: {
    actionType?: string | null;
    channel?: string | null;
    summary?: string | null;
  } | null;
  latestDraft?: {
    threadId?: string | null;
    channel?: string | null;
    createdAt?: string | null;
  } | null;
  executionState?: {
    code?: string | null;
    label?: string | null;
    detail?: string | null;
    tone?: "good" | "warn" | "bad" | "neutral" | null;
  } | null;
  closeLoopPolicySummary?: {
    mode?: "suggest_only" | "autosend_allowed" | "live_autonomy_allowed" | "blocked" | null;
    label?: string | null;
    detail?: string | null;
    tone?: "good" | "warn" | "bad" | "neutral" | null;
  } | null;
};

type MediaAnalysisSummaryResponse = {
  ok?: boolean;
  analysis?: {
    source?: string | null;
    visibleVolumeRange?: string | null;
    mergedVolumeRange?: string | null;
    confidence?: "low" | "medium" | "high" | null;
    videoCount?: number | null;
    missingViews?: string[] | null;
    summary?: string | null;
  } | null;
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

function tonePanelClasses(value: "good" | "warn" | "bad" | "neutral" | null | undefined): string {
  switch (value) {
    case "good":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "bad":
      return "border-rose-200 bg-rose-50 text-rose-900";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
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

function readMetaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!meta) return null;
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readMetaStringArray(meta: Record<string, unknown> | null | undefined, key: string): string[] {
  if (!meta) return [];
  const value = meta[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function formatMetaLabel(value: string | null): string | null {
  if (!value) return null;
  return value
    .split("_")
    .filter((part) => part.trim().length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
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
  q?: string | null;
  offset?: string | number | null;
}): string {
  const params = new URLSearchParams();
  params.set("tab", "inbox");
  if (input.status) params.set("status", input.status);
  if (input.threadId) params.set("threadId", input.threadId);
  if (input.contactId) params.set("contactId", input.contactId);
  if (input.channel) params.set("channel", input.channel);
  if (input.q) params.set("inbox_q", input.q);
  if (typeof input.offset === "number" && Number.isFinite(input.offset) && input.offset > 0) {
    params.set("inbox_offset", String(Math.floor(input.offset)));
  } else if (typeof input.offset === "string" && input.offset.trim().length > 0) {
    params.set("inbox_offset", input.offset.trim());
  }
  return `/team?${params.toString()}`;
}

type InboxSectionProps = {
  threadId?: string;
  status?: string;
  contactId?: string;
  channel?: string;
  q?: string;
  offset?: string;
};

function isSupportedChannel(value: string | null | undefined): value is "sms" | "email" | "dm" {
  return value === "sms" || value === "email" || value === "dm";
}

export async function InboxSection({ threadId, status, contactId, channel, q, offset }: InboxSectionProps): Promise<React.ReactElement> {
  const searchQuery = (q ?? "").trim().replace(/\s+/g, " ");
  const activeStatus = status ?? (searchQuery ? "all" : "open");
  const requestedChannel = isSupportedChannel(channel) ? channel : "sms";

  const params = new URLSearchParams();
  params.set("limit", searchQuery ? "200" : "50");
  if (searchQuery) {
    params.set("q", searchQuery);
  }
  const parsedOffset = offset ? Number(offset) : NaN;
  if (Number.isFinite(parsedOffset) && parsedOffset > 0) {
    params.set("offset", String(Math.floor(parsedOffset)));
  }

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
  const latestInboundAt = [...timelineMessages]
    .reverse()
    .find((message) => message.direction === "inbound")
    ?.createdAt ?? null;
  const latestOutboundAt = [...timelineMessages]
    .reverse()
    .find((message) => message.direction === "outbound" && !isDraftMessage(message.metadata ?? null))
    ?.createdAt ?? null;
  const latestAiDraftAt = [...timelineMessages]
    .reverse()
    .find(
      (message) =>
        message.direction === "outbound" &&
        isDraftMessage(message.metadata ?? null) &&
        message.metadata?.["aiSuggested"] === true,
    )
    ?.createdAt ?? null;

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
  const currentThreadAiDraft =
    selectedThreadId
      ? [...activeThreadMessages]
          .reverse()
          .find(
            (message) =>
              message.threadId === selectedThreadId &&
              message.direction === "outbound" &&
              isDraftMessage(message.metadata ?? null) &&
              message.metadata?.["aiSuggested"] === true,
          ) ?? null
      : null;
  const currentThreadAiDraftPlanner = currentThreadAiDraft
    ? {
        actionType: formatMetaLabel(readMetaString(currentThreadAiDraft.metadata ?? null, "aiPlannerActionType")),
        summary: readMetaString(currentThreadAiDraft.metadata ?? null, "aiPlannerSummary"),
        reason: readMetaString(currentThreadAiDraft.metadata ?? null, "aiPlannerReason"),
        priority: formatMetaLabel(readMetaString(currentThreadAiDraft.metadata ?? null, "aiPlannerPriority")),
        confidence: formatMetaLabel(readMetaString(currentThreadAiDraft.metadata ?? null, "aiPlannerConfidence")),
        bookingReadiness: formatMetaLabel(readMetaString(currentThreadAiDraft.metadata ?? null, "aiBookingReadiness")),
        quoteConfidence: formatMetaLabel(readMetaString(currentThreadAiDraft.metadata ?? null, "aiQuoteConfidence")),
        memorySummary: truncateText(readMetaString(currentThreadAiDraft.metadata ?? null, "aiMemorySummary"), 180),
      }
    : null;
  let nextActionSummary: NextActionSummaryResponse | null = null;
  let mediaAnalysisSummary: MediaAnalysisSummaryResponse | null = null;
  if (activeContactId) {
    try {
      const [nextActionRes, mediaAnalysisRes] = await Promise.all([
        callAdminApi(
          `/api/admin/contacts/${encodeURIComponent(activeContactId)}/sales-agent-next-action?includeQuotePrice=1`,
        ),
        callAdminApi(
          `/api/admin/contacts/${encodeURIComponent(activeContactId)}/media-analysis?includeQuotePrice=1`,
        ),
      ]);
      if (nextActionRes.ok) {
        nextActionSummary = (await nextActionRes.json().catch(() => null)) as NextActionSummaryResponse | null;
      }
      if (mediaAnalysisRes.ok) {
        mediaAnalysisSummary = (await mediaAnalysisRes.json().catch(() => null)) as MediaAnalysisSummaryResponse | null;
      }
    } catch {
      nextActionSummary = null;
      mediaAnalysisSummary = null;
    }
  }

  const agentExecutionState = nextActionSummary?.executionState ?? null;
  const agentExecutionCode = agentExecutionState?.code ?? null;
  const agentNextAction = nextActionSummary?.nextAction ?? null;
  const agentCloseLoopPolicy = nextActionSummary?.closeLoopPolicySummary ?? null;
  const agentCloseLoopMode = agentCloseLoopPolicy?.mode ?? null;
  const agentTargetChannel = isSupportedChannel(agentNextAction?.channel) ? agentNextAction.channel : requestedChannel;
  const agentIsChannelHandoff = agentTargetChannel !== requestedChannel;
  const agentLatestDraft = nextActionSummary?.latestDraft ?? null;
  const agentExternalDraft =
    typeof agentLatestDraft?.threadId === "string" &&
    agentLatestDraft.threadId.trim().length > 0 &&
    agentLatestDraft.threadId !== selectedThreadId
      ? {
          threadId: agentLatestDraft.threadId.trim(),
          channel: isSupportedChannel(agentLatestDraft.channel) ? agentLatestDraft.channel : agentTargetChannel,
        }
      : null;
  const agentAutoSendDue = agentExecutionCode === "autosend_due" && Boolean(currentThreadAiDraft);
  const agentDraftPending = agentExecutionCode === "draft_pending" && !currentThreadAiDraft;
  const agentPrimaryTitle = agentAutoSendDue
    ? "Next move: send now or let autosend handle it"
    : currentThreadAiDraft && agentCloseLoopMode === "suggest_only"
      ? "Next move: review the suggestion"
    : currentThreadAiDraft && agentCloseLoopMode === "live_autonomy_allowed"
      ? "Next move: this reply is live-autonomy capable"
    : !currentThreadAiDraft && agentCloseLoopMode === "autosend_allowed"
      ? "Next move: prepare the autosend draft"
    : !currentThreadAiDraft && agentCloseLoopMode === "live_autonomy_allowed"
      ? "Next move: prepare the live-autonomy reply"
    : agentExternalDraft
      ? `Next move: open ${agentExternalDraft.channel === "sms" ? "SMS" : agentExternalDraft.channel.toUpperCase()} draft`
    : agentIsChannelHandoff && !currentThreadAiDraft
      ? `Next move: switch to ${agentTargetChannel === "sms" ? "text" : agentTargetChannel.toUpperCase()}`
    : currentThreadAiDraft
      ? "Next move: approve and send"
      : agentDraftPending
        ? "Next move: prepare the reply"
        : "Next move: prepare the reply";
  const agentPrimaryDescription = agentAutoSendDue
    ? "This follow-up is already due and eligible for autosend. Send it now if you want to move first, or leave it alone and let the worker handle it."
    : currentThreadAiDraft && agentCloseLoopMode === "suggest_only"
      ? "This close-loop action is still approval-first under your current settings. Review the drafted suggestion and send it manually if you want to move now."
    : currentThreadAiDraft && agentCloseLoopMode === "live_autonomy_allowed"
      ? "This close-loop reply is already allowed for live autonomy on this channel, but you can still review and send it manually here."
    : !currentThreadAiDraft && agentCloseLoopMode === "autosend_allowed"
      ? "This close-loop follow-up is approved for autosend once a draft exists. Prepare it here if you want to inspect or send it yourself first."
    : !currentThreadAiDraft && agentCloseLoopMode === "live_autonomy_allowed"
      ? "This close-loop reply is allowed for live autonomy on this channel. Prepare it here if you want to inspect the exact reply first."
    : agentExternalDraft
      ? `The agent already prepared this reply on ${agentExternalDraft.channel === "sms" ? "SMS" : agentExternalDraft.channel.toUpperCase()}. Open that draft and send it from the correct channel thread.`
    : agentIsChannelHandoff && !currentThreadAiDraft
      ? `The planner wants to continue this conversation over ${agentTargetChannel === "sms" ? "SMS" : agentTargetChannel.toUpperCase()}. Prepare that handoff draft here and the inbox will take you to the right channel thread.`
    : currentThreadAiDraft
      ? "The agent has already written the next reply. Review it here and send from this card."
      : agentDraftPending
        ? "The planner says this thread should get a draft now. Prepare it here without digging through the rest of the inbox."
        : "No draft is ready yet. Let the agent prepare the next reply for this thread.";
  const agentPrimaryButtonLabel = agentAutoSendDue
    ? "Send now"
    : agentExternalDraft
      ? `Open ${agentExternalDraft.channel === "sms" ? "SMS" : agentExternalDraft.channel.toUpperCase()} draft`
    : agentIsChannelHandoff && !currentThreadAiDraft
      ? `Prepare ${agentTargetChannel === "sms" ? "SMS" : agentTargetChannel.toUpperCase()} draft`
    : currentThreadAiDraft
      ? agentCloseLoopMode === "suggest_only"
        ? "Send suggestion"
        : "Send now"
      : agentCloseLoopMode === "suggest_only"
        ? "Prepare suggestion"
        : agentCloseLoopMode === "autosend_allowed"
          ? "Prepare autosend draft"
          : agentCloseLoopMode === "live_autonomy_allowed"
            ? "Prepare live reply"
            : "Prepare next reply";
  const agentSecondaryButtonLabel = currentThreadAiDraft && !agentAutoSendDue ? "Refresh draft" : null;
  const agentPassiveChoiceLabel = agentAutoSendDue ? "Let autosend handle it" : null;
  const agentGateLabel =
    agentCloseLoopMode === "suggest_only"
      ? currentThreadAiDraft
        ? "Reviewing suggestion"
        : "Suggestion only"
      : agentCloseLoopMode === "autosend_allowed"
        ? "Autosend allowed"
        : agentCloseLoopMode === "live_autonomy_allowed"
          ? "Live autonomy allowed"
          : agentCloseLoopMode === "blocked"
            ? "Blocked for review"
            : null;
  const agentGateDetail = agentCloseLoopPolicy?.detail ?? null;
  const agentDraftFooterInstruction =
    agentCloseLoopMode === "suggest_only"
      ? "Use the Agent card above to review, edit, or send this suggestion."
      : agentCloseLoopMode === "autosend_allowed"
        ? agentAutoSendDue
          ? "Use the Agent card above to send it now, or leave it alone and let autosend handle it."
          : "Use the Agent card above to review it first, or leave it in place for autosend once it is due."
        : agentCloseLoopMode === "live_autonomy_allowed"
          ? "Use the Agent card above to send it manually now, or keep it as a live-autonomy-capable reply."
          : agentCloseLoopMode === "blocked"
            ? "Use the Agent card above to resolve the human-review hold before this draft moves forward."
            : "Use the Agent card above to send or refresh this draft.";
  const agentMediaAnalysis = mediaAnalysisSummary?.analysis ?? null;
  const agentMediaUsesVision =
    typeof agentMediaAnalysis?.source === "string" && agentMediaAnalysis.source.toLowerCase().includes("vision");
  const agentMediaVisibleRange = formatMetaLabel(agentMediaAnalysis?.visibleVolumeRange ?? null);
  const agentMediaMergedRange = formatMetaLabel(agentMediaAnalysis?.mergedVolumeRange ?? null);
  const agentMediaConfidence = formatMetaLabel(agentMediaAnalysis?.confidence ?? null);
  const agentMediaMissingView =
    Array.isArray(agentMediaAnalysis?.missingViews) && agentMediaAnalysis.missingViews.length > 0
      ? agentMediaAnalysis.missingViews.find((item) => typeof item === "string" && item.trim().length > 0) ?? null
      : null;
  const agentMediaIsWeak =
    agentMediaUsesVision &&
    (agentMediaAnalysis?.confidence === "low" || Boolean(agentMediaMissingView));
  const agentWeakEstimateHeadline =
    currentThreadAiDraftPlanner?.actionType === "collect_missing_info"
      ? "Estimate needs one better angle"
      : "Estimate is still visually weak";
  const agentWeakEstimateDetail =
    agentMediaMissingView && agentMediaAnalysis?.confidence === "low"
      ? `The current photos/video are low-confidence. One better angle would help: ${agentMediaMissingView}.`
      : agentMediaMissingView
        ? `The current estimate is missing one key view. Best next angle: ${agentMediaMissingView}.`
        : agentMediaAnalysis?.confidence === "low"
          ? "The current photos/video do not give the agent enough confidence to treat the estimate like it is fully locked in."
          : null;
  const agentMediaSummary =
    agentMediaVisibleRange && agentMediaMergedRange && agentMediaVisibleRange !== agentMediaMergedRange
      ? `Visible ${agentMediaVisibleRange}; merged to ${agentMediaMergedRange}.`
      : agentMediaMergedRange
        ? `Estimate looks around ${agentMediaMergedRange}.`
        : agentMediaVisibleRange
          ? `Visible estimate looks around ${agentMediaVisibleRange}.`
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
        className={`flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-4 py-3 text-sm text-[color:var(--team-text-muted)] shadow-[0_18px_36px_var(--team-card-shadow)] ${
          showConversation ? "hidden lg:flex" : ""
        }`}
      >
        <input type="hidden" name="tab" value="inbox" />
        <input
          name="inbox_q"
          type="search"
          defaultValue={searchQuery}
          placeholder="Search name, phone, or email…"
          className="min-w-[220px] flex-1 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
        <select
          name="status"
          defaultValue={activeStatus}
          className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm text-[color:var(--team-text)] shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
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
          Search
        </button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)_340px] xl:grid-cols-[400px_minmax(0,1fr)_380px]">
        <div
          className={`space-y-4 rounded-3xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-[0_24px_56px_var(--team-card-shadow)] backdrop-blur ${
            showConversation ? "hidden lg:block" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-[color:var(--team-text)]">Threads</h3>
            <span className="text-xs text-[color:var(--team-text-soft)]">
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
                        channel: landingChannel,
                        q: searchQuery || null
                      })
                    : buildInboxHref({
                        status: activeStatus === "all" ? null : activeStatus,
                        threadId: group.threads[0]?.id ?? null,
                        q: searchQuery || null
                      });

                  return (
                    <div
                      key={group.key}
                      className={`rounded-2xl border px-4 py-3 text-sm transition duration-150 ${
                        isActive
                          ? "border-[color:var(--team-border-strong)] bg-[color:var(--team-list-item-active)] shadow-[0_14px_32px_var(--team-card-shadow)]"
                          : "border-[color:var(--team-border)] bg-[color:var(--team-list-item)] hover:border-[color:var(--team-border-strong)] hover:bg-[color:var(--team-list-item-hover)]"
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
                                  channel: t.channel,
                                  q: searchQuery || null
                                })
                              : buildInboxHref({
                                  status: activeStatus === "all" ? null : activeStatus,
                                  threadId: t.id,
                                  q: searchQuery || null
                                });
                            const isChannelActive = isActive && t.channel === requestedChannel;
                            return (
                              <a
                                key={t.id}
                                href={href}
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
                                  isChannelActive
                                    ? "border-[color:var(--team-border-strong)] bg-[color:var(--team-list-item-active)] text-primary-800"
                                    : "border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)] hover:border-[color:var(--team-border-strong)] hover:text-primary-700"
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
          className={`rounded-3xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] shadow-[0_24px_56px_var(--team-card-shadow)] backdrop-blur ${
            showConversation ? "" : "hidden lg:block"
          }`}
        >
          {activeContactId ? (
            <div className="flex flex-col gap-4 overflow-hidden p-5">
              <div className="flex flex-col gap-3 border-b border-[color:var(--team-border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
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
                {selectedThreadId && activeContactId ? (
                  <InboxLiveUpdatesClient
                    threadId={selectedThreadId}
                    contactId={activeContactId}
                    channel={requestedChannel}
                    initialMessageCount={timelineMessages.length}
                    initialLastMessageAt={activeThread?.lastMessageAt ?? null}
                  />
                ) : null}
                {selectedThreadId ? (
                  <InboxAutoDraftClient
                    threadId={selectedThreadId}
                    channel={requestedChannel}
                    latestInboundAt={latestInboundAt}
                    latestOutboundAt={latestOutboundAt}
                    latestAiDraftAt={latestAiDraftAt}
                  />
                ) : null}
                {selectedThreadId && activeContactId ? (
                  <div className="rounded-2xl border border-primary-200 bg-primary-50/60 p-4 text-sm text-slate-700">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-xs font-semibold uppercase tracking-wide text-primary-800">Agent</div>
                          <div className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold text-primary-800">
                            {currentThreadAiDraft ? "Ready to review" : "Watching this thread"}
                          </div>
                          {currentThreadAiDraftPlanner?.actionType ? (
                            <div className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold text-slate-700">
                              {currentThreadAiDraftPlanner.actionType}
                            </div>
                          ) : null}
                          {currentThreadAiDraftPlanner?.priority ? (
                            <div className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold text-slate-700">
                              {currentThreadAiDraftPlanner.priority}
                            </div>
                          ) : null}
                        </div>
                        <div className="mt-2 text-sm font-semibold text-slate-900">
                          {agentPrimaryTitle}
                        </div>
                        <div className="mt-1 text-sm text-slate-700">{agentPrimaryDescription}</div>
                        {currentThreadAiDraftPlanner?.summary ? (
                          <div className="mt-2 text-sm text-slate-700">{currentThreadAiDraftPlanner.summary}</div>
                        ) : null}
                        {currentThreadAiDraftPlanner?.reason ? (
                          <div className="mt-2 text-xs text-slate-600">
                            <span className="font-semibold text-slate-700">Why now:</span> {currentThreadAiDraftPlanner.reason}
                          </div>
                        ) : null}
                        {agentGateLabel ? (
                          <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${tonePanelClasses(agentCloseLoopPolicy?.tone ?? "neutral")}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">{agentGateLabel}</span>
                              {agentCloseLoopPolicy?.label ? (
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium">
                                  {agentCloseLoopPolicy.label}
                                </span>
                              ) : null}
                            </div>
                            {agentGateDetail ? <div className="mt-1">{agentGateDetail}</div> : null}
                          </div>
                        ) : null}
                        {agentMediaUsesVision && (agentMediaSummary || agentMediaMissingView) ? (
                          <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">Media-informed</span>
                              {agentMediaAnalysis?.videoCount && agentMediaAnalysis.videoCount > 0 ? (
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                                  video + photo estimate
                                </span>
                              ) : (
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                                  photo estimate
                                </span>
                              )}
                              {agentMediaConfidence ? (
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                                  {agentMediaConfidence} confidence
                                </span>
                              ) : null}
                            </div>
                            {agentMediaSummary ? <div className="mt-1">{agentMediaSummary}</div> : null}
                            {agentMediaMissingView ? (
                              <div className="mt-1 text-[11px] text-sky-900">
                                Best next angle: {agentMediaMissingView}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {agentMediaIsWeak && agentWeakEstimateDetail ? (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                            <div className="font-semibold text-amber-900">{agentWeakEstimateHeadline}</div>
                            <div className="mt-1">{agentWeakEstimateDetail}</div>
                          </div>
                        ) : null}
                        <div className="mt-3">
                          <ContactSalesAgentNextActionClient contactId={activeContactId} compact />
                        </div>
                        {agentPassiveChoiceLabel && agentExecutionState?.detail ? (
                          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                            <span className="font-semibold">{agentPassiveChoiceLabel}.</span> {agentExecutionState.detail}
                          </div>
                        ) : null}
                        {currentThreadAiDraft ? (
                          <div className="mt-3 rounded-xl border border-white/80 bg-white/80 px-3 py-2 text-xs text-slate-700">
                            <div className="font-semibold text-slate-800">Current draft</div>
                            <div className="mt-1 whitespace-pre-wrap break-words">
                              {truncateText(currentThreadAiDraft.body, 280) ?? "Draft ready"}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                              <span>Updated {formatTimestamp(currentThreadAiDraft.createdAt)}</span>
                              {currentThreadAiDraftPlanner?.bookingReadiness ? <span>Booking: {currentThreadAiDraftPlanner.bookingReadiness}</span> : null}
                              {currentThreadAiDraftPlanner?.quoteConfidence ? <span>Quote confidence: {currentThreadAiDraftPlanner.quoteConfidence}</span> : null}
                              {currentThreadAiDraftPlanner?.confidence ? <span>Planner confidence: {currentThreadAiDraftPlanner.confidence}</span> : null}
                            </div>
                            {currentThreadAiDraftPlanner?.memorySummary ? (
                              <div className="mt-2 text-[11px] text-slate-500">{currentThreadAiDraftPlanner.memorySummary}</div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {agentExternalDraft ? (
                          <a
                            href={buildInboxHref({
                              status: activeStatus === "all" ? null : activeStatus,
                              threadId: agentExternalDraft.threadId,
                              contactId: activeContactId,
                              channel: agentExternalDraft.channel,
                              q: searchQuery || null,
                              offset: offset ?? null,
                            })}
                            className={teamButtonClass("primary", "sm")}
                          >
                            {agentPrimaryButtonLabel}
                          </a>
                        ) : currentThreadAiDraft ? (
                          <form action={sendDraftMessageAction}>
                            <input type="hidden" name="messageId" value={currentThreadAiDraft.id} />
                            <input type="hidden" name="threadId" value={selectedThreadId} />
                            <input type="hidden" name="contactId" value={activeContactId} />
                            <input type="hidden" name="channel" value={requestedChannel} />
                            <SubmitButton
                              className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-primary-700"
                              pendingLabel="Sending..."
                            >
                              {agentPrimaryButtonLabel}
                            </SubmitButton>
                          </form>
                        ) : (
                          <form action={suggestThreadReplyAction}>
                            <input type="hidden" name="threadId" value={selectedThreadId} />
                            <input type="hidden" name="contactId" value={activeContactId} />
                            <input type="hidden" name="channel" value={agentTargetChannel} />
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Drafting..."
                            >
                              {agentPrimaryButtonLabel}
                            </SubmitButton>
                          </form>
                        )}
                        {agentSecondaryButtonLabel ? (
                          <form action={suggestThreadReplyAction}>
                            <input type="hidden" name="threadId" value={selectedThreadId} />
                            <input type="hidden" name="contactId" value={activeContactId} />
                            <input type="hidden" name="channel" value={agentTargetChannel} />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Refreshing..."
                            >
                              {agentSecondaryButtonLabel}
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                {timelineMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-[color:var(--team-surface-muted)] p-4 text-sm text-slate-500">
                    No messages yet. Send the first touch below.
                  </div>
                ) : (
                  timelineMessages.map((message) => {
                    const isOutbound = message.direction !== "inbound";
                    const autoReply = isAutoReply(message.metadata ?? null);
                    const autoReplyDelayMs = readMetaNumber(message.metadata ?? null, "autoReplyDelayMs");
                    const isDraft = isDraftMessage(message.metadata ?? null);
                    const isAiSuggested = message.metadata?.["aiSuggested"] === true;
                    const aiPlanIntent = formatMetaLabel(readMetaString(message.metadata ?? null, "aiPlanIntent"));
                    const aiPlanNextAction = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiPlanNextAction"),
                    );
                    const aiPlannerActionType = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiPlannerActionType"),
                    );
                    const aiPlannerSummary = readMetaString(message.metadata ?? null, "aiPlannerSummary");
                    const aiPlannerReason = readMetaString(message.metadata ?? null, "aiPlannerReason");
                    const aiBookingReadiness = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiBookingReadiness"),
                    );
                    const aiQuoteConfidence = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiQuoteConfidence"),
                    );
                    const aiChannelPreference = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiChannelPreference"),
                    );
                    const aiPlannerPriority = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiPlannerPriority"),
                    );
                    const aiPlannerConfidence = formatMetaLabel(
                      readMetaString(message.metadata ?? null, "aiPlannerConfidence"),
                    );
                    const aiPlanQuestions = readMetaStringArray(message.metadata ?? null, "aiPlanQuestions");
                    const aiMemorySummary = readMetaString(message.metadata ?? null, "aiMemorySummary");
                    const statusLabel = isDraft ? "draft" : message.deliveryStatus;
                    const hasMedia = Array.isArray(message.mediaUrls) && message.mediaUrls.length > 0;
                    const trimmedBody = typeof message.body === "string" ? message.body.trim() : "";
                    const showBody = trimmedBody.length > 0 && !(hasMedia && trimmedBody === "Media message");
                    const managedByAgentCard =
                      currentThreadAiDraft?.id === message.id &&
                      isDraft &&
                      isAiSuggested;
                    const draftGateLabel =
                      managedByAgentCard && agentCloseLoopMode === "suggest_only"
                        ? "Suggestion only"
                        : managedByAgentCard && agentCloseLoopMode === "autosend_allowed"
                          ? "Autosend allowed"
                          : managedByAgentCard && agentCloseLoopMode === "live_autonomy_allowed"
                            ? "Live autonomy allowed"
                            : managedByAgentCard && agentCloseLoopMode === "blocked"
                              ? "Blocked for review"
                              : null;
                    return (
                      <div key={message.id} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl border border-[color:var(--team-border)] px-4 py-3 text-sm shadow-[0_12px_28px_var(--team-card-shadow)] lg:max-w-[640px] ${
                            isOutbound
                              ? "bg-[color:var(--team-bubble-outbound)] text-[color:var(--team-text)]"
                              : "bg-[color:var(--team-bubble-inbound)] text-[color:var(--team-text-muted)]"
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
                          {isDraft && isAiSuggested ? (
                            <div className="mb-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-[11px] text-slate-600">
                              {draftGateLabel && agentGateDetail ? (
                                <div className={`mb-2 rounded-xl border px-2 py-2 ${tonePanelClasses(agentCloseLoopPolicy?.tone ?? "neutral")}`}>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold">{draftGateLabel}</span>
                                    {agentCloseLoopPolicy?.label ? (
                                      <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium">
                                        {agentCloseLoopPolicy.label}
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="mt-1">{agentGateDetail}</div>
                                </div>
                              ) : null}
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                {aiPlannerActionType ? <span><span className="font-semibold text-slate-700">Planner:</span> {aiPlannerActionType}</span> : null}
                                {aiPlanIntent ? <span><span className="font-semibold text-slate-700">Goal:</span> {aiPlanIntent}</span> : null}
                                {aiPlanNextAction ? <span><span className="font-semibold text-slate-700">Trying to:</span> {aiPlanNextAction}</span> : null}
                                {aiBookingReadiness ? <span><span className="font-semibold text-slate-700">Booking:</span> {aiBookingReadiness}</span> : null}
                                {aiQuoteConfidence ? <span><span className="font-semibold text-slate-700">Confidence:</span> {aiQuoteConfidence}</span> : null}
                                {aiChannelPreference ? <span><span className="font-semibold text-slate-700">Best channel:</span> {aiChannelPreference}</span> : null}
                                {aiPlannerPriority ? <span><span className="font-semibold text-slate-700">Priority:</span> {aiPlannerPriority}</span> : null}
                                {aiPlannerConfidence ? <span><span className="font-semibold text-slate-700">Planner confidence:</span> {aiPlannerConfidence}</span> : null}
                              </div>
                              {aiPlannerSummary ? (
                                <div className="mt-2">
                                  <span className="font-semibold text-slate-700">Planner summary:</span>{" "}
                                  {aiPlannerSummary}
                                </div>
                              ) : null}
                              {aiPlannerReason ? (
                                <div className="mt-2">
                                  <span className="font-semibold text-slate-700">Why now:</span>{" "}
                                  {aiPlannerReason}
                                </div>
                              ) : null}
                              {aiPlanQuestions.length > 0 ? (
                                <div className="mt-2">
                                  <span className="font-semibold text-slate-700">Question focus:</span>{" "}
                                  {aiPlanQuestions.join(" ")}
                                </div>
                              ) : null}
                              {aiMemorySummary ? (
                                <div className="mt-2 text-slate-500">
                                  {aiMemorySummary}
                                </div>
                              ) : null}
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
                          {managedByAgentCard ? (
                            <div className="mt-3 text-right text-[11px] font-medium text-slate-500">
                              {draftGateLabel
                                ? `${draftGateLabel}. ${agentDraftFooterInstruction}`
                                : "Use the Agent card above to send or refresh this draft."}
                            </div>
                          ) : isOutbound && isDraft ? (
                            <div className="mt-3 flex justify-end">
                              <form action={sendDraftMessageAction}>
                                <input type="hidden" name="messageId" value={message.id} />
                                {selectedThreadId ? <input type="hidden" name="threadId" value={selectedThreadId} /> : null}
                                <input type="hidden" name="contactId" value={activeContactId ?? ""} />
                                <input type="hidden" name="channel" value={requestedChannel} />
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

              <div className="-mx-5 relative z-10 border-t border-[color:var(--team-border)] bg-[color:var(--team-card)] px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur">
                <form
                  action={sendThreadMessageAction}
                  method="post"
                  encType="multipart/form-data"
                  className="space-y-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
                >
                  <input type="hidden" name="contactId" value={activeContactId} />
                  <input type="hidden" name="channel" value={requestedChannel} />
                  {selectedThreadId ? <input type="hidden" name="threadId" value={selectedThreadId} /> : null}
                  {requestedChannel === "email" ? (
                    <label className="flex flex-col gap-1 text-xs text-[color:var(--team-text-muted)]">
                      <span>Subject</span>
                      <input
                        name="subject"
                        defaultValue={(selectedThread as { subject?: string | null } | null)?.subject ?? ""}
                        className={TEAM_INPUT_COMPACT}
                      />
                    </label>
                  ) : null}
                  <label className="flex flex-col gap-1 text-xs text-[color:var(--team-text-muted)]">
                    <span className="flex items-center justify-between gap-3">
                      <span>Message</span>
                      <InboxSpeechToTextButtonClient textareaId="inbox-thread-body" />
                    </span>
                    <textarea id="inbox-thread-body" name="body" rows={3} className={TEAM_INPUT_COMPACT} />
                  </label>
                  {requestedChannel === "sms" || requestedChannel === "dm" ? (
                    <label className="flex flex-col gap-1 text-xs text-[color:var(--team-text-muted)]">
                      <span>Attach photos (optional)</span>
                      <input
                        type="file"
                        name="attachments"
                        accept="image/*,video/*"
                        multiple
                        className="block w-full rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-xs text-[color:var(--team-text-muted)]"
                      />
                      <span className="text-[11px] text-[color:var(--team-text-soft)]">You can send photos with or without text.</span>
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

        <div className="hidden rounded-3xl border border-[color:var(--team-border)] bg-[color:var(--team-panel-alt)] shadow-[0_24px_56px_var(--team-card-shadow)] backdrop-blur lg:block">
          <div className="flex max-h-[78dvh] flex-col gap-4 overflow-hidden p-5">
            <div className="flex items-start justify-between gap-3 border-b border-[color:var(--team-border)] pb-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-[color:var(--team-text)]">Details</h3>
                <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">Keep context handy while you reply.</p>
              </div>
            </div>

            {activeContactId ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 shadow-[0_10px_24px_var(--team-card-shadow)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold text-[color:var(--team-text)]">
                          {activeContact?.name ?? "Unknown contact"}
                        </div>
                        <ContactNameEditorClient contactId={activeContactId} contactName={activeContact?.name ?? ""} />
                      </div>
                      <div className="mt-1 space-y-1 text-xs text-[color:var(--team-text-muted)]">
                        {activeContact?.phone ? (
                          <div>Phone: {activeContact.phone}</div>
                        ) : (
                          <div className="text-[color:var(--team-text-soft)]">Phone: not on file</div>
                        )}
                        {activeContact?.email ? (
                          <div>Email: {activeContact.email}</div>
                        ) : (
                          <div className="text-[color:var(--team-text-soft)]">Email: not on file</div>
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
                    <div className="mt-3 border-t border-[color:var(--team-border)] pt-3 text-xs text-[color:var(--team-text-muted)]">
                      <div className="font-semibold text-[color:var(--team-text-muted)]">Address</div>
                      <div className="mt-1">
                        {activeProperty.addressLine1}
                        <div className="text-[color:var(--team-text-soft)]">
                          {activeProperty.city}, {activeProperty.state} {activeProperty.postalCode}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <InboxContactRemindersClient contactId={activeContactId} initialReminders={contactReminders} />

                <InboxContactNotesClient contactId={activeContactId} initialNotes={contactNotes} />

                <ContactSalesAgentMemoryClient contactId={activeContactId} />
                <ContactMediaAnalysisClient contactId={activeContactId} />
                <ContactSalesAgentNextActionClient contactId={activeContactId} />

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
