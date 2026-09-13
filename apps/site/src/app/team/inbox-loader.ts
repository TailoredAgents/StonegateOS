import {
  isInboxPagination,
  isInboxQueueCounts,
  isInboxSnapshotSignature,
  type InboxPagination,
} from "./inbox-state";
import {
  parseInboxThreadPagePayload,
  type InboxThreadMessagePage,
} from "./inbox-thread-page";

export type ThreadSummary = {
  id: string;
  status: string;
  state?: string | null;
  stateUpdatedAt?: string | null;
  updatedAt?: string | null;
  channel: string;
  subject: string | null;
  sourceFamily?: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  firstInboundAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  waitingSince?: string | null;
  attentionReason?: string | null;
  needsAttention?: boolean;
  priorityScore?: number;
  mediaCount?: number;
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
  failedMessageCount?: number;
  followup?: {
    state: string | null;
    step: number | null;
    nextAt: string | null;
  } | null;
  facebookSales?: {
    stage: string;
    autonomyMode: string;
    lastDecision: string | null;
    lastDecisionReason: string | null;
    lastHumanReviewReason: string | null;
    quoteLowCents: number | null;
    quoteHighCents: number | null;
    updatedAt: string | null;
  } | null;
};

export type ThreadDetail = {
  id: string;
  partnerJob?: { accountId: string; jobId: string } | null;
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

export type MessageDetail = {
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
  sentAt?: string | null;
  receivedAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ThreadResponse = {
  thread: ThreadDetail;
  participants: unknown[];
  messages: MessageDetail[];
  messagePage: InboxThreadMessagePage;
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

export type TimelineResponse = {
  snapshot?: {
    signature: string;
    messageCount: number;
  };
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  };
  threads: TimelineThread[];
  messages: MessageDetail[];
};

export type InboxLoadError = {
  message: string;
  status?: number;
};

export type InboxInput = {
  queue?: string;
  threadId?: string;
  status?: string;
  contactId?: string;
  channel?: string;
  q?: string;
  view?: string;
  firstMessageFrom?: string;
  firstMessageTo?: string;
  lastMessageFrom?: string;
  lastMessageTo?: string;
  offset?: string;
  messageCursor?: string | readonly string[];
  messageLimit?: string | readonly string[];
};

export function inboxFilters(input: InboxInput) {
  const queue =
    input.queue === "failed" || input.queue === "needs_reply"
      ? input.queue
      : !input.queue && input.view === "attention" && input.status !== "closed"
        ? "needs_reply"
        : "all";
  return {
    queue,
    view: input.view === "google" ? "google" : "all",
    q: (input.q ?? "").trim().replace(/\s+/g, " "),
    firstMessageFrom: input.firstMessageFrom?.trim() || "",
    firstMessageTo: input.firstMessageTo?.trim() || "",
    lastMessageFrom: input.lastMessageFrom?.trim() || "",
    lastMessageTo: input.lastMessageTo?.trim() || "",
  } as const;
}

type ReadInbox = (path: string) => Promise<Response>;
function isContact(
  value: unknown,
): value is NonNullable<ThreadDetail["contact"]> {
  if (!value || typeof value !== "object") return false;
  const contact = value as Record<string, unknown>;
  return (
    typeof contact["id"] === "string" &&
    typeof contact["name"] === "string" &&
    (contact["email"] === null || typeof contact["email"] === "string") &&
    (contact["phone"] === null || typeof contact["phone"] === "string")
  );
}
function isListThread(value: unknown): value is ThreadSummary {
  if (!value || typeof value !== "object") return false;
  const thread = value as Record<string, unknown>;
  return (
    typeof thread["id"] === "string" &&
    typeof thread["channel"] === "string" &&
    typeof thread["status"] === "string" &&
    (thread["subject"] === null || typeof thread["subject"] === "string") &&
    (thread["lastMessagePreview"] === null ||
      typeof thread["lastMessagePreview"] === "string") &&
    (thread["lastMessageAt"] === null ||
      typeof thread["lastMessageAt"] === "string") &&
    (thread["contact"] === null || isContact(thread["contact"]))
  );
}
const supported = (
  value: string | undefined,
): value is "sms" | "email" | "dm" =>
  value === "sms" || value === "email" || value === "dm";

function loadError(status: number | undefined): InboxLoadError {
  return {
    status,
    message:
      status === 401
        ? "Your session expired. Sign in again to read this conversation."
        : status === 403
          ? "You do not have access to this conversation."
          : status === 404
            ? "This conversation could not be found."
            : status === 409
              ? "This older page has expired. Open the latest messages."
              : status === 400 || status === 422
                ? "This conversation page link is invalid. Open the latest messages."
                : "Messages could not be loaded. Your draft is saved; please retry.",
  };
}

/** Resolve identity before reading a page. Optional CRM/AI/provider data never enters this path. */
export async function loadInboxConversation(
  input: InboxInput,
  read: ReadInbox,
) {
  let selectedThreadId = input.threadId?.trim().toLowerCase() || null;
  let contactId = selectedThreadId
    ? null
    : input.contactId?.trim().toLowerCase() || null;
  let channel: "sms" | "email" | "dm" | "web" = supported(input.channel)
    ? input.channel
    : "sms";
  let contact: ThreadDetail["contact"] = null;
  let timeline: TimelineResponse | null = null;
  let error: InboxLoadError | null = null;
  let detail: ThreadResponse | null = null;
  // Explicit thread links are authoritative, even when an old contact/channel remains in the URL.
  // Customer/channel links must resolve an existing thread before requesting its strict message page.
  if (!selectedThreadId && contactId) {
    const response = await read(
      `/api/admin/inbox/timeline?contactId=${encodeURIComponent(contactId)}&limit=50`,
    ).catch(() => null);
    if (!response?.ok) error = loadError(response?.status);
    else {
      const payload = (await response
        .json()
        .catch(() => null)) as TimelineResponse | null;
      if (
        !isContact(payload?.contact) ||
        payload.contact.id !== contactId ||
        !Array.isArray(payload.threads) ||
        !Array.isArray(payload.messages) ||
        payload.threads.some(
          (t) =>
            !t || typeof t.id !== "string" || typeof t.channel !== "string",
        )
      ) {
        error = {
          message:
            "The customer conversation list did not load completely. Please retry.",
        };
      } else {
        timeline = payload;
        contact = payload.contact;
        const candidates = payload.threads.filter((t) => t.channel === channel);
        candidates.sort(
          (a, b) =>
            Date.parse(b.lastMessageAt ?? "1970-01-01") -
            Date.parse(a.lastMessageAt ?? "1970-01-01"),
        );
        selectedThreadId = candidates[0]?.id ?? null;
      }
    }
  }

  if (selectedThreadId) {
    const params = new URLSearchParams();
    const limits =
      typeof input.messageLimit === "string"
        ? [input.messageLimit]
        : (input.messageLimit ?? ["50"]);
    const expectedLimit =
      limits.length === 1 && /^[1-9]\d{0,2}$/u.test(limits[0]!)
        ? Number(limits[0])
        : -1;
    limits.forEach((value) => params.append("limit", value));
    if (input.messageCursor !== undefined) {
      const cursors =
        typeof input.messageCursor === "string"
          ? [input.messageCursor]
          : input.messageCursor;
      cursors.forEach((value) => params.append("cursor", value));
    }
    const response = await read(
      `/api/admin/inbox/threads/${encodeURIComponent(selectedThreadId)}?${params}`,
    ).catch(() => null);
    if (!response?.ok) error = loadError(response?.status);
    else {
      const payload: unknown = await response.json().catch(() => null);
      const parsed = parseInboxThreadPagePayload(
        payload,
        selectedThreadId,
        expectedLimit,
        input.messageCursor === undefined ? "newest" : "history",
      );
      if (!parsed)
        error = {
          message: "The message page did not load completely. Please retry.",
        };
      else {
        detail = parsed as unknown as ThreadResponse;
        // Do not adopt a mismatched customer returned during customer/channel resolution.
        if (
          contactId &&
          (detail.thread.contact?.id !== contactId ||
            detail.thread.partnerJob ||
            detail.thread.channel !== channel)
        ) {
          detail = null;
          error = {
            message:
              "This conversation does not match the selected customer. Please retry.",
          };
        } else {
          const thread = detail.thread;
          channel = thread.partnerJob
            ? "web"
            : supported(thread.channel)
              ? thread.channel
              : "web";
          contact = thread.partnerJob ? null : thread.contact;
          contactId = contact?.id ?? null;
        }
      }
    }
  }
  return {
    selectedThreadId,
    contactId,
    channel,
    contact,
    detail,
    error,
    timeline,
    isPartnerConversation: Boolean(detail?.thread.partnerJob),
    hasSelection: Boolean(input.threadId || input.contactId),
  };
}

export async function loadInboxList(input: InboxInput, read: ReadInbox) {
  const filters = inboxFilters(input);
  const parsedOffset = Number(input.offset ?? 0);
  const offset =
    Number.isSafeInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const params = new URLSearchParams({ limit: "50", queue: filters.queue });
  for (const [key, value] of Object.entries(filters))
    if (value && value !== "all") params.set(key, value);
  if (offset) params.set("offset", String(offset));
  const result: {
    threads: ThreadSummary[];
    pagination: InboxPagination;
    signature: string | null;
    error: InboxLoadError | null;
  } = {
    threads: [],
    pagination: { limit: 50, offset, total: 0, nextOffset: null },
    signature: null,
    error: null,
  };
  const response = await read(`/api/admin/inbox/threads?${params}`).catch(
    () => null,
  );
  if (!response?.ok) {
    result.error = {
      message:
        response?.status === 403
          ? "You do not have access to these conversations."
          : "Conversations could not be loaded. Please retry.",
      status: response?.status,
    };
    return result;
  }
  const payload = (await response.json().catch(() => null)) as {
    threads?: unknown[];
    queueCounts?: unknown;
    snapshot?: { signature?: unknown };
    pagination?: unknown;
  } | null;
  if (
    !payload ||
    !Array.isArray(payload.threads) ||
    !payload.threads.every(isListThread) ||
    !isInboxQueueCounts(payload.queueCounts) ||
    !isInboxSnapshotSignature(payload.snapshot?.signature) ||
    !isInboxPagination(payload.pagination, payload.threads.length, 50, offset)
  ) {
    result.error = {
      message: "The conversation list did not load completely. Please retry.",
    };
    return result;
  }
  result.threads = payload.threads;
  result.pagination = payload.pagination;
  result.signature = payload.snapshot.signature;
  return result;
}

export function inboxContactName(
  contact: ThreadDetail["contact"],
  fallback = "Customer",
): string {
  const name = contact?.name?.trim();
  return name && !/^unknown(?: contact| caller)?$/i.test(name)
    ? name
    : contact?.phone || contact?.email || fallback;
}

export function groupInboxThreads(threads: ThreadSummary[]) {
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key =
      thread.channel === "web"
        ? `thread:${thread.id}`
        : (thread.contact?.id ?? `thread:${thread.id}`);
    groups.set(key, [...(groups.get(key) ?? []), thread]);
  }
  const activity = (t: ThreadSummary) =>
    Date.parse(
      t.lastMessageAt ?? t.lastInboundAt ?? t.updatedAt ?? "1970-01-01",
    ) || 0;
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      threads: rows.sort((a, b) => activity(b) - activity(a)),
    }))
    .sort((a, b) => activity(b.threads[0]!) - activity(a.threads[0]!));
}
