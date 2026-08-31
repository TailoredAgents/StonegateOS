import {
  detectExpenseReceiptContentType,
  expenseErrorMessage,
} from "../spend-v2-utils";
import {
  readBinaryUploadFile,
  verifyBinaryUploadPayload,
} from "./binary-upload";
import { getOrCreateMobileDeviceId } from "./offline-media";

export const MOBILE_EXPENSE_QUEUE_EVENT = "stonegate:expense-queue-change";
export const MOBILE_EXPENSE_SYNC_TAG = "stonegate-expense-receipts";

const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 4;
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const MEDIA_QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const EXPENSE_QUEUE_STORE = "expense-capture-queue";
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const QUEUE_HEALTH_TIMEOUT_MS = 30 * 1000;
const QUEUE_HEALTH_REFRESH_MS = 5 * 60 * 1000;
const QUEUE_HEALTH_FAILURE_BACKOFF_MS = 60 * 1000;
const SERVICE_WORKER_READY_TIMEOUT_MS = 1500;

const queueHealthReports = new Map<
  string,
  { fingerprint: string; reportedAt: number }
>();
const queueHealthFailuresUntil = new Map<string, number>();
const queueHealthInFlight = new Map<string, Promise<boolean>>();

export function createKeyedSingleFlight<Key, Value>(): (
  key: Key,
  operation: () => Promise<Value>,
) => Promise<Value> {
  const active = new Map<Key, Promise<Value>>();
  return (key, operation) => {
    const existing = active.get(key);
    if (existing) return existing;

    const pending = Promise.resolve().then(operation);
    const settled = pending.finally(() => {
      if (active.get(key) === settled) active.delete(key);
    });
    active.set(key, settled);
    return settled;
  };
}

export type ExpenseCaptureQueueStatus =
  | "draft"
  | "queued"
  | "syncing"
  | "processing"
  | "ready"
  | "confirmed"
  | "discarded"
  | "failed";

export type ExpenseCaptureQueueRow = {
  clientCaptureId: string;
  employeeId: string;
  filename: string;
  contentType: string;
  byteLength: number;
  checksumSha256: string;
  bytes?: ArrayBuffer;
  status: ExpenseCaptureQueueStatus;
  error: string | null;
  attempts: number;
  serverCapture: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

export type ExpenseCaptureQueueHealthSummary = {
  queuedCount: number;
  failedCount: number;
  oldestQueuedAt: number | null;
};

const runCaptureSyncSingleFlight = createKeyedSingleFlight<
  string,
  ExpenseCaptureQueueRow
>();
const runEmployeeSyncSingleFlight = createKeyedSingleFlight<string, void>();

function requiresServerAcknowledgement(row: ExpenseCaptureQueueRow): boolean {
  if (row.serverCapture) return false;
  return ["queued", "syncing", "failed"].includes(row.status);
}

export function summarizeExpenseCaptureQueueHealth(
  rows: readonly ExpenseCaptureQueueRow[],
): ExpenseCaptureQueueHealthSummary {
  const pending = rows.filter(requiresServerAcknowledgement);
  return {
    queuedCount: pending.length,
    failedCount: pending.filter(
      (row) => row.status === "failed" || Boolean(row.error),
    ).length,
    oldestQueuedAt: pending.reduce<number | null>(
      (oldest, row) =>
        oldest === null || row.createdAt < oldest ? row.createdAt : oldest,
      null,
    ),
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("expense_queue_database_error"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("expense_queue_aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("expense_queue_failed")),
      { once: true },
    );
  });
}

function ensureDatabaseStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
    const store = database.createObjectStore(SNAPSHOT_STORE, {
      keyPath: "key",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("expiresAt", "expiresAt", { unique: false });
  }
  if (!database.objectStoreNames.contains(MEDIA_STORE)) {
    const store = database.createObjectStore(MEDIA_STORE, { keyPath: "key" });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("appointmentId", "appointmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(MEDIA_QUEUE_STORE)) {
    const store = database.createObjectStore(MEDIA_QUEUE_STORE, {
      keyPath: "clientId",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("appointmentId", "appointmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(METADATA_STORE)) {
    database.createObjectStore(METADATA_STORE, { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains(EXPENSE_QUEUE_STORE)) {
    const store = database.createObjectStore(EXPENSE_QUEUE_STORE, {
      keyPath: "clientCaptureId",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("status", "status", { unique: false });
    store.createIndex("updatedAt", "updatedAt", { unique: false });
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("expense_queue_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => ensureDatabaseStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("expense_queue_open_failed"));
  });
}

function dispatchQueueChange(employeeId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MOBILE_EXPENSE_QUEUE_EVENT, { detail: { employeeId } }),
  );
}

async function writeRow(row: ExpenseCaptureQueueRow): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(EXPENSE_QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(EXPENSE_QUEUE_STORE).put(row);
  try {
    await completion;
  } finally {
    database.close();
  }
  dispatchQueueChange(row.employeeId);
}

export async function getExpenseCaptureQueueRow(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow | null> {
  const database = await openDatabase();
  const transaction = database.transaction(EXPENSE_QUEUE_STORE, "readonly");
  const completion = transactionDone(transaction);
  const row = await requestResult<ExpenseCaptureQueueRow | undefined>(
    transaction
      .objectStore(EXPENSE_QUEUE_STORE)
      .get(clientCaptureId) as IDBRequest<ExpenseCaptureQueueRow | undefined>,
  );
  try {
    await completion;
  } finally {
    database.close();
  }
  return row ?? null;
}

export async function listExpenseCaptureQueue(
  employeeId: string,
): Promise<ExpenseCaptureQueueRow[]> {
  const database = await openDatabase();
  const transaction = database.transaction(EXPENSE_QUEUE_STORE, "readonly");
  const completion = transactionDone(transaction);
  const rows = await requestResult<ExpenseCaptureQueueRow[]>(
    transaction.objectStore(EXPENSE_QUEUE_STORE).getAll() as IDBRequest<
      ExpenseCaptureQueueRow[]
    >,
  );
  try {
    await completion;
  } finally {
    database.close();
  }
  return rows
    .filter((row) => row.employeeId === employeeId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function createExpenseCaptureDraft(
  employeeId: string,
  file: File,
): Promise<ExpenseCaptureQueueRow> {
  let prepared;
  try {
    prepared = await readBinaryUploadFile({
      file,
      maxBytes: MAX_RECEIPT_BYTES,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "binary_upload_size_invalid"
    ) {
      throw new Error("Receipts must be 10 MB or smaller.");
    }
    throw new Error("The receipt could not be read.");
  }
  const { bytes, checksumSha256 } = prepared;
  const contentType = detectExpenseReceiptContentType(bytes);
  if (!contentType) {
    throw new Error(
      "This receipt file could not be verified. Use a JPEG, PNG, WebP, HEIC, or PDF.",
    );
  }
  const now = Date.now();
  const row: ExpenseCaptureQueueRow = {
    clientCaptureId: crypto.randomUUID(),
    employeeId,
    filename: file.name || "receipt",
    contentType,
    byteLength: bytes.byteLength,
    checksumSha256,
    bytes,
    status: "draft",
    error: null,
    attempts: 0,
    serverCapture: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeRow(row);
  return row;
}

export async function queueExpenseCapture(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow> {
  const row = await getExpenseCaptureQueueRow(clientCaptureId);
  if (!row) throw new Error("The saved receipt is unavailable.");
  const queued: ExpenseCaptureQueueRow = {
    ...row,
    status: "queued",
    error: null,
    updatedAt: Date.now(),
  };
  await writeRow(queued);
  void registerExpenseBackgroundSync();
  return queued;
}

export async function removeExpenseCapture(
  clientCaptureId: string,
): Promise<void> {
  const row = await getExpenseCaptureQueueRow(clientCaptureId);
  const database = await openDatabase();
  const transaction = database.transaction(EXPENSE_QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(EXPENSE_QUEUE_STORE).delete(clientCaptureId);
  try {
    await completion;
  } finally {
    database.close();
  }
  if (row) dispatchQueueChange(row.employeeId);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

async function responsePayload(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return objectValue(await response.json().catch(() => null));
}

export function expenseCaptureQueueStatus(
  serverStatus: unknown,
): ExpenseCaptureQueueStatus {
  if (serverStatus === "ready") return "ready";
  if (serverStatus === "confirmed") return "confirmed";
  if (serverStatus === "discarded") return "discarded";
  if (serverStatus === "failed") return "failed";
  return "processing";
}

export function shouldPollExpenseCaptureStatus(
  status: ExpenseCaptureQueueStatus,
): boolean {
  return status === "processing";
}

function captureFailureMessage(
  capture: Record<string, unknown> | null,
): string | null {
  return capture?.["status"] === "failed"
    ? expenseErrorMessage(capture["failure"], "Receipt analysis failed.")
    : null;
}

async function performExpenseCaptureSync(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow> {
  const current = await getExpenseCaptureQueueRow(clientCaptureId);
  if (!current) throw new Error("The saved receipt is unavailable.");
  if (
    current.status === "draft" ||
    current.status === "confirmed" ||
    current.status === "discarded" ||
    (current.status === "failed" && current.serverCapture !== null)
  ) {
    return current;
  }
  if (
    current.serverCapture &&
    (current.status === "ready" || current.status === "processing")
  ) {
    return refreshExpenseCapture(current.clientCaptureId);
  }
  if (!current.bytes && current.status !== "processing") {
    const failed = {
      ...current,
      status: "failed" as const,
      error: "The original receipt is unavailable on this device.",
      updatedAt: Date.now(),
    };
    await writeRow(failed);
    return failed;
  }

  const syncing: ExpenseCaptureQueueRow = {
    ...current,
    status: current.status === "processing" ? "processing" : "syncing",
    error: null,
    attempts: current.attempts + 1,
    updatedAt: Date.now(),
  };
  await writeRow(syncing);

  try {
    if (syncing.status === "processing") {
      return await refreshExpenseCapture(syncing.clientCaptureId);
    }
    const intentResponse = await fetch("/api/mobile/expenses/captures", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCaptureId: syncing.clientCaptureId,
        filename: syncing.filename,
        contentType: syncing.contentType,
        byteLength: syncing.byteLength,
        checksumSha256: syncing.checksumSha256,
      }),
    });
    const intentPayload = await responsePayload(intentResponse);
    if (!intentResponse.ok) {
      throw new Error(
        expenseErrorMessage(
          intentPayload,
          "The receipt upload could not start.",
        ),
      );
    }
    const intentCapture = objectValue(intentPayload?.["capture"]);
    const intentStatus = expenseCaptureQueueStatus(intentCapture?.["status"]);
    if (
      intentStatus === "ready" ||
      intentStatus === "confirmed" ||
      intentStatus === "discarded" ||
      intentStatus === "failed"
    ) {
      const reconciled = {
        ...syncing,
        bytes: undefined,
        status: intentStatus,
        error: captureFailureMessage(intentCapture),
        serverCapture: intentCapture,
        updatedAt: Date.now(),
      };
      await writeRow(reconciled);
      return reconciled;
    }
    const uploadUrl =
      typeof intentPayload?.["uploadUrl"] === "string"
        ? intentPayload["uploadUrl"]
        : null;
    if (uploadUrl) {
      const uploadBody = await verifyBinaryUploadPayload({
        bytes: syncing.bytes,
        expectedByteLength: syncing.byteLength,
        expectedChecksumSha256: syncing.checksumSha256,
      });
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": syncing.contentType },
        body: uploadBody,
      });
      if (!uploadResponse.ok) {
        throw new Error("The receipt upload was interrupted.");
      }
    }
    const finalizeResponse = await fetch(
      `/api/mobile/expenses/captures/${encodeURIComponent(syncing.clientCaptureId)}/finalize`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checksumSha256: syncing.checksumSha256 }),
      },
    );
    const finalizePayload = await responsePayload(finalizeResponse);
    if (!finalizeResponse.ok) {
      throw new Error(
        expenseErrorMessage(
          finalizePayload,
          "The receipt upload could not be confirmed.",
        ),
      );
    }
    const serverCapture = objectValue(finalizePayload?.["capture"]);
    const acknowledged: ExpenseCaptureQueueRow = {
      ...syncing,
      bytes: undefined,
      status: expenseCaptureQueueStatus(serverCapture?.["status"]),
      error: captureFailureMessage(serverCapture),
      serverCapture,
      updatedAt: Date.now(),
    };
    await writeRow(acknowledged);
    return acknowledged;
  } catch (error) {
    const retry: ExpenseCaptureQueueRow = {
      ...syncing,
      status: "queued",
      error: error instanceof Error ? error.message : "The receipt will retry.",
      updatedAt: Date.now(),
    };
    await writeRow(retry);
    void registerExpenseBackgroundSync();
    return retry;
  }
}

export function syncExpenseCapture(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow> {
  return runCaptureSyncSingleFlight(clientCaptureId, () =>
    performExpenseCaptureSync(clientCaptureId),
  );
}

export async function refreshExpenseCapture(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow> {
  const current = await getExpenseCaptureQueueRow(clientCaptureId);
  if (!current) throw new Error("The saved receipt is unavailable.");
  const response = await fetch(
    `/api/mobile/expenses/captures/${encodeURIComponent(clientCaptureId)}`,
    { credentials: "include", cache: "no-store" },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(
      expenseErrorMessage(payload, "Receipt status is unavailable."),
    );
  }
  const serverCapture = objectValue(payload?.["capture"]);
  const row: ExpenseCaptureQueueRow = {
    ...current,
    status: expenseCaptureQueueStatus(serverCapture?.["status"]),
    error: captureFailureMessage(serverCapture),
    serverCapture,
    updatedAt: Date.now(),
  };
  await writeRow(row);
  return row;
}

async function performEmployeeExpenseCaptureSync(
  employeeId: string,
): Promise<void> {
  const rows = await listExpenseCaptureQueue(employeeId);
  for (const row of rows) {
    if (
      row.status === "draft" ||
      row.status === "confirmed" ||
      row.status === "discarded"
    ) {
      continue;
    }
    await syncExpenseCapture(row.clientCaptureId).catch(() => undefined);
  }
}

export function syncEmployeeExpenseCaptures(employeeId: string): Promise<void> {
  return runEmployeeSyncSingleFlight(employeeId, () =>
    performEmployeeExpenseCaptureSync(employeeId),
  );
}

async function performExpenseQueueHealthReport(
  employeeId: string,
): Promise<boolean> {
  try {
    const summary = summarizeExpenseCaptureQueueHealth(
      await listExpenseCaptureQueue(employeeId),
    );
    const fingerprint = `${summary.queuedCount}:${summary.failedCount}:${summary.oldestQueuedAt ?? ""}`;
    const lastReport = queueHealthReports.get(employeeId);
    const now = Date.now();
    if (
      lastReport?.fingerprint === fingerprint &&
      lastReport.reportedAt > now - QUEUE_HEALTH_REFRESH_MS
    ) {
      return true;
    }

    const controller = new AbortController();
    const timer = globalThis.setTimeout(
      () => controller.abort(),
      QUEUE_HEALTH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch("/api/mobile/expenses/queue-health", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: await getOrCreateMobileDeviceId(),
          queuedCount: summary.queuedCount,
          failedCount: summary.failedCount,
          oldestQueuedAt:
            summary.oldestQueuedAt === null
              ? null
              : new Date(summary.oldestQueuedAt).toISOString(),
          reportedAt: new Date(now).toISOString(),
        }),
      });
    } finally {
      globalThis.clearTimeout(timer);
    }
    if (!response.ok) {
      queueHealthFailuresUntil.set(
        employeeId,
        Date.now() + QUEUE_HEALTH_FAILURE_BACKOFF_MS,
      );
      return false;
    }
    queueHealthFailuresUntil.delete(employeeId);
    queueHealthReports.set(employeeId, { fingerprint, reportedAt: now });
    return true;
  } catch {
    queueHealthFailuresUntil.set(
      employeeId,
      Date.now() + QUEUE_HEALTH_FAILURE_BACKOFF_MS,
    );
    return false;
  }
}

export function reportExpenseQueueHealth(employeeId: string): Promise<boolean> {
  const active = queueHealthInFlight.get(employeeId);
  if (active) return active;
  if ((queueHealthFailuresUntil.get(employeeId) ?? 0) > Date.now()) {
    return Promise.resolve(false);
  }

  const promise = performExpenseQueueHealthReport(employeeId);
  const settled = promise.finally(() => {
    if (queueHealthInFlight.get(employeeId) === settled) {
      queueHealthInFlight.delete(employeeId);
    }
  });
  queueHealthInFlight.set(employeeId, settled);
  return settled;
}

export async function registerExpenseBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  try {
    const existing = await navigator.serviceWorker.getRegistration("/mobile");
    const registration =
      existing ??
      (await new Promise<ServiceWorkerRegistration | null>((resolve) => {
        let finished = false;
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        const finish = (value: ServiceWorkerRegistration | null) => {
          if (finished) return;
          finished = true;
          if (timeout !== null) globalThis.clearTimeout(timeout);
          resolve(value);
        };
        timeout = globalThis.setTimeout(
          () => finish(null),
          SERVICE_WORKER_READY_TIMEOUT_MS,
        );
        void navigator.serviceWorker.ready.then(
          (value) => finish(value),
          () => finish(null),
        );
      }));
    if (!registration) return;
    if ("sync" in registration) {
      await (
        registration as ServiceWorkerRegistration & {
          sync: { register(tag: string): Promise<void> };
        }
      ).sync.register(MOBILE_EXPENSE_SYNC_TAG);
    }
  } catch {
    // Foreground reconnect/visibility listeners retry the same durable queue.
  }
}
