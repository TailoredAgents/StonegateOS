const STORAGE_PREFIX = "stonegate:mobile-job-draft:v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 100;

export type MobileJobDraftScope = {
  employeeId: string;
  appointmentId: string;
  appointmentVersion: string | null;
  kind: string;
};

type StoredDraft<T = unknown> = {
  employeeId: string;
  appointmentId: string;
  kind: string;
  appointmentVersion: string | null;
  updatedAt: number;
  values: T;
};

export type MobileJobDraft<T> = {
  values: T;
  appointmentVersion: string | null;
  updatedAt: number;
  matchesVersion: boolean;
};

// This layer only stores editable drafts. Reading one never sends a completion,
// payment, or message request. Consumers decide how to review changed versions.
const sessionDrafts = new Map<string, StoredDraft>();

function draftKey(
  scope: Pick<MobileJobDraftScope, "employeeId" | "appointmentId" | "kind">,
): string {
  return `${STORAGE_PREFIX}${[scope.employeeId, scope.appointmentId, scope.kind].map(encodeURIComponent).join(":")}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseDraft(value: string | null): StoredDraft | null {
  if (!value) return null;
  try {
    const draft: unknown = JSON.parse(value);
    if (
      !draft ||
      typeof draft !== "object" ||
      !("employeeId" in draft) ||
      typeof draft.employeeId !== "string" ||
      !("appointmentId" in draft) ||
      typeof draft.appointmentId !== "string" ||
      !("kind" in draft) ||
      typeof draft.kind !== "string" ||
      !("appointmentVersion" in draft) ||
      (draft.appointmentVersion !== null &&
        typeof draft.appointmentVersion !== "string") ||
      !("updatedAt" in draft) ||
      typeof draft.updatedAt !== "number" ||
      !Number.isFinite(draft.updatedAt) ||
      !("values" in draft)
    )
      return null;
    return draft as StoredDraft;
  } catch {
    return null;
  }
}

function pruneDrafts(
  storage: Storage | null,
  now: number,
  keepKey: string,
): void {
  for (const [key, draft] of sessionDrafts) {
    if (now - draft.updatedAt > MAX_AGE_MS) sessionDrafts.delete(key);
  }
  const order = (
    a: { key: string; updatedAt: number },
    b: { key: string; updatedAt: number },
  ) =>
    a.key === keepKey ? -1 : b.key === keepKey ? 1 : b.updatedAt - a.updatedAt;
  const memoryKeys = [...sessionDrafts.entries()].sort((a, b) =>
    order(
      { key: a[0], updatedAt: a[1].updatedAt },
      { key: b[0], updatedAt: b[1].updatedAt },
    ),
  );
  for (const [key] of memoryKeys.slice(MAX_DRAFTS)) sessionDrafts.delete(key);
  if (!storage) return;
  try {
    const records: { key: string; updatedAt: number }[] = [];
    // Copy keys before deleting: localStorage indexes shift after removal.
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    );
    for (const key of keys) {
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const draft = parseDraft(storage.getItem(key));
      if (!draft || now - draft.updatedAt > MAX_AGE_MS) storage.removeItem(key);
      else records.push({ key, updatedAt: draft.updatedAt });
    }
    records.sort(order);
    for (const record of records.slice(MAX_DRAFTS))
      storage.removeItem(record.key);
  } catch {
    // Storage is optional; the mounted form and session copy remain usable.
  }
}

export function readMobileJobDraft<T>(
  scope: MobileJobDraftScope,
): MobileJobDraft<T> | null {
  if (!scope.employeeId || !scope.appointmentId) return null;
  const key = draftKey(scope);
  const storage = browserStorage();
  let draft = sessionDrafts.get(key) ?? null;
  try {
    const saved = parseDraft(storage?.getItem(key) ?? null);
    if (saved && (!draft || saved.updatedAt > draft.updatedAt)) draft = saved;
  } catch {
    // Retain a session draft when browser persistence is unavailable.
  }
  if (
    !draft ||
    draft.employeeId !== scope.employeeId ||
    draft.appointmentId !== scope.appointmentId ||
    draft.kind !== scope.kind
  )
    return null;
  if (Date.now() - draft.updatedAt > MAX_AGE_MS) {
    clearMobileJobDraft(scope);
    return null;
  }
  sessionDrafts.set(key, draft);
  return {
    values: draft.values as T,
    appointmentVersion: draft.appointmentVersion,
    updatedAt: draft.updatedAt,
    matchesVersion: draft.appointmentVersion === scope.appointmentVersion,
  };
}

export function writeMobileJobDraft<T>(
  scope: MobileJobDraftScope,
  values: T,
): { persisted: boolean } {
  if (!scope.employeeId || !scope.appointmentId) return { persisted: false };
  const key = draftKey(scope);
  const draft: StoredDraft<T> = { ...scope, values, updatedAt: Date.now() };
  sessionDrafts.set(key, draft);
  const storage = browserStorage();
  pruneDrafts(storage, draft.updatedAt, key);
  try {
    if (!storage) return { persisted: false };
    storage.setItem(key, JSON.stringify(draft));
    pruneDrafts(storage, draft.updatedAt, key);
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

export function clearMobileJobDraft(
  scope: Pick<MobileJobDraftScope, "employeeId" | "appointmentId" | "kind">,
): void {
  const key = draftKey(scope);
  sessionDrafts.delete(key);
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // A denied storage operation must not block the user's action.
  }
}

export function clearMobileJobDrafts(employeeId?: string): void {
  for (const [key, draft] of sessionDrafts) {
    if (!employeeId || draft.employeeId === employeeId)
      sessionDrafts.delete(key);
  }
  const storage = browserStorage();
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    );
    for (const key of keys) {
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const draft = parseDraft(storage.getItem(key));
      if (!employeeId || draft?.employeeId === employeeId)
        storage.removeItem(key);
    }
  } catch {
    // Logout and clearing the session copy still proceed.
  }
}
