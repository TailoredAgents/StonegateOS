import {
  isInboxPreparedMessage,
  type InboxComposerAudience,
  type InboxComposerChannel,
  type InboxPreparedMessage,
} from "./inbox-composer-types";

export type InboxDraftScope = {
  employeeId: string;
  threadId: string | null;
  contactId: string | null;
  channel: InboxComposerChannel;
  audience: InboxComposerAudience;
};
export type InboxDraftValues = {
  body: string;
  subject: string;
  fileNames: string[];
};
export type InboxComposerDraft = InboxDraftValues & {
  updatedAt: number;
  pending?: { prepared: InboxPreparedMessage; submitted: InboxDraftValues };
};
export type InboxDraftInsertion = {
  employeeId?: string;
  contactId: string | null;
  threadId?: string | null;
  channel: InboxComposerChannel;
  audience?: InboxComposerAudience;
  body: string;
  subject?: string;
};
export const INBOX_DRAFT_INSERT_EVENT = "stonegate:inbox-draft-insert";
export const INBOX_DRAFT_CHANGED_EVENT = "stonegate:inbox-draft-changed";
const PREFIX = "stonegate:inbox-draft:v1:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const memory = new Map<string, InboxComposerDraft>();
const files = new Map<string, File[]>();
const aliases = new Map<string, string>();
const operations = new Set<string>();
let activeEmployeeId: string | null = null;

export function inboxDraftKey(scope: InboxDraftScope): string {
  return (
    PREFIX +
    [
      scope.employeeId,
      scope.threadId
        ? `thread:${scope.threadId}`
        : `contact:${scope.contactId ?? "none"}`,
      scope.channel,
      scope.audience,
    ]
      .map(encodeURIComponent)
      .join(":")
  );
}

function contactKey(scope: InboxDraftScope): string {
  return inboxDraftKey({ ...scope, threadId: null });
}

function effectiveKey(scope: InboxDraftScope): string {
  const key = inboxDraftKey(scope);
  return !scope.threadId ? (aliases.get(key) ?? key) : key;
}

function notifyDraftChange(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(INBOX_DRAFT_CHANGED_EVENT));
}

export function inboxComposerOperationRunning(scope: InboxDraftScope): boolean {
  return operations.has(
    scope.contactId ? contactKey(scope) : inboxDraftKey(scope),
  );
}
export function beginInboxComposerOperation(scope: InboxDraftScope): boolean {
  const key = scope.contactId ? contactKey(scope) : inboxDraftKey(scope);
  if (operations.has(key)) return false;
  operations.add(key);
  notifyDraftChange();
  return true;
}
export function endInboxComposerOperation(scope: InboxDraftScope): void {
  operations.delete(scope.contactId ? contactKey(scope) : inboxDraftKey(scope));
  notifyDraftChange();
}

function validValues(value: unknown): value is InboxDraftValues {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["body"] === "string" &&
    typeof record["subject"] === "string" &&
    Array.isArray(record["fileNames"]) &&
    record["fileNames"].every((name) => typeof name === "string")
  );
}

function readKey(key: string): InboxComposerDraft | null {
  let value: unknown = memory.get(key);
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) {
      const candidate = JSON.parse(stored) as { updatedAt?: number };
      if (
        !value ||
        (typeof candidate?.updatedAt === "number" &&
          candidate.updatedAt > (value as InboxComposerDraft).updatedAt)
      )
        value = candidate;
    }
  } catch {
    /* Memory remains usable. */
  }
  if (!validValues(value)) return null;
  const draft = value as InboxComposerDraft;
  if (
    !Number.isFinite(draft.updatedAt) ||
    (!draft.pending && Date.now() - draft.updatedAt > MAX_AGE)
  )
    return null;
  if (
    draft.pending &&
    (!isInboxPreparedMessage(draft.pending.prepared) ||
      !validValues(draft.pending.submitted))
  )
    return null;
  return draft;
}

export function readInboxComposerDraft(
  scope: InboxDraftScope,
): InboxComposerDraft | null {
  const key = effectiveKey(scope);
  let draft = readKey(key);
  if (scope.threadId && scope.contactId) {
    const queuedKey = contactKey(scope);
    aliases.set(queuedKey, key);
    const queued = readKey(queuedKey);
    if (
      queued &&
      (!queued.pending ||
        (!draft?.pending &&
          queued.pending.prepared.threadId === scope.threadId))
    ) {
      draft = {
        ...draft,
        ...(queued.pending ? { pending: queued.pending } : {}),
        body: [draft?.body, queued.body].filter(Boolean).join("\n\n"),
        subject: draft?.subject || queued.subject,
        fileNames: [...(draft?.fileNames ?? []), ...queued.fileNames],
        updatedAt: Date.now(),
      };
      const queuedFiles = files.get(queuedKey);
      if (queuedFiles)
        files.set(key, [...(files.get(key) ?? []), ...queuedFiles]);
      removeKey(queuedKey);
      writeInboxComposerDraft(scope, draft);
    }
  }
  if (
    draft?.pending &&
    (draft.pending.prepared.employeeId !== scope.employeeId ||
      draft.pending.prepared.channel !== scope.channel ||
      draft.pending.prepared.contactId !== scope.contactId ||
      (scope.threadId && draft.pending.prepared.threadId !== scope.threadId) ||
      (draft.pending.prepared.payload.audience ?? "") !== scope.audience)
  )
    return null;
  return draft;
}

export function writeInboxComposerDraft(
  scope: InboxDraftScope,
  value: InboxComposerDraft,
): boolean {
  const key = effectiveKey(scope);
  const draft = { ...value, updatedAt: Date.now() };
  memory.set(key, draft);
  while (memory.size > 100) {
    // An unresolved send must retain its original operation key until checked.
    const oldest = [...memory.entries()].find(
      ([, saved]) => !saved.pending,
    )?.[0];
    if (oldest) removeKey(oldest);
    else break;
  }
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
    notifyDraftChange();
    return true;
  } catch {
    notifyDraftChange();
    return false;
  }
}

function removeKey(key: string): void {
  memory.delete(key);
  files.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Nothing else to clear. */
  }
}
export function clearInboxComposerDraft(scope: InboxDraftScope): void {
  removeKey(effectiveKey(scope));
  notifyDraftChange();
}
export function readInboxComposerFiles(scope: InboxDraftScope): File[] {
  return files.get(effectiveKey(scope)) ?? [];
}
export function writeInboxComposerFiles(
  scope: InboxDraftScope,
  values: File[],
): void {
  files.set(effectiveKey(scope), values);
}
export function registerInboxComposerEmployee(employeeId: string): void {
  activeEmployeeId = employeeId;
}

export function inboxComposerIsBusy(): boolean {
  const composer =
    typeof document === "undefined"
      ? null
      : document.querySelector("[data-inbox-composer]");
  return Boolean(
    composer &&
      (composer.getAttribute("data-inbox-composer-dirty") === "true" ||
        composer.contains(document.activeElement)),
  );
}

/** Inserts are always additive and scoped. They never dispatch a message. */
export function insertInboxComposerDraft(input: InboxDraftInsertion): boolean {
  const employeeId = input.employeeId ?? activeEmployeeId;
  if (
    !employeeId ||
    !input.body.trim() ||
    (activeEmployeeId && employeeId !== activeEmployeeId)
  )
    return false;
  const event = new CustomEvent(INBOX_DRAFT_INSERT_EVENT, {
    detail: { ...input, employeeId },
    cancelable: true,
  });
  window.dispatchEvent(event);
  if (event.defaultPrevented) return true;
  const scope: InboxDraftScope = {
    employeeId,
    threadId: input.threadId ?? null,
    contactId: input.contactId,
    channel: input.channel,
    audience: input.audience ?? "",
  };
  const aliased = !scope.threadId ? aliases.get(contactKey(scope)) : null;
  const existing = aliased ? readKey(aliased) : readInboxComposerDraft(scope);
  const next = {
    ...existing,
    body: [existing?.body, input.body.trim()].filter(Boolean).join("\n\n"),
    subject: existing?.subject || input.subject || "",
    fileNames: existing?.fileNames ?? [],
    updatedAt: Date.now(),
  };
  if (aliased) {
    memory.set(aliased, next);
    try {
      sessionStorage.setItem(aliased, JSON.stringify(next));
    } catch {
      /* Memory fallback. */
    }
  } else writeInboxComposerDraft(scope, next);
  return true;
}
