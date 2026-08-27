import {
  expenseErrorMessage,
  expenseReceiptContentType,
} from "../spend-v2-utils";

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

export type ExpenseCaptureQueueStatus =
  | "draft"
  | "queued"
  | "syncing"
  | "processing"
  | "ready"
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function createExpenseCaptureDraft(
  employeeId: string,
  file: File,
): Promise<ExpenseCaptureQueueRow> {
  const contentType = expenseReceiptContentType(file);
  if (!contentType)
    throw new Error("Use a JPEG, PNG, WebP, HEIC, or PDF receipt.");
  if (file.size < 1 || file.size > MAX_RECEIPT_BYTES) {
    throw new Error("Receipts must be 10 MB or smaller.");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size)
    throw new Error("The receipt could not be read.");
  const checksumSha256 = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
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
  await registerExpenseBackgroundSync();
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

function captureStatus(
  capture: Record<string, unknown> | null,
): ExpenseCaptureQueueStatus {
  if (capture?.["status"] === "ready") return "ready";
  if (capture?.["status"] === "failed") return "failed";
  return "processing";
}

export async function syncExpenseCapture(
  clientCaptureId: string,
): Promise<ExpenseCaptureQueueRow> {
  const current = await getExpenseCaptureQueueRow(clientCaptureId);
  if (!current) throw new Error("The saved receipt is unavailable.");
  if (current.status === "draft" || current.status === "ready") return current;
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
    if (intentCapture?.["status"] === "ready") {
      const ready = {
        ...syncing,
        bytes: undefined,
        status: "ready" as const,
        serverCapture: intentCapture,
        updatedAt: Date.now(),
      };
      await writeRow(ready);
      return ready;
    }
    const uploadUrl =
      typeof intentPayload?.["uploadUrl"] === "string"
        ? intentPayload["uploadUrl"]
        : null;
    if (uploadUrl && syncing.bytes) {
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": syncing.contentType },
        body: syncing.bytes.slice(0),
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
      status: captureStatus(serverCapture),
      error:
        serverCapture?.["status"] === "failed"
          ? expenseErrorMessage(
              serverCapture["failure"],
              "Receipt analysis failed.",
            )
          : null,
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
    await registerExpenseBackgroundSync();
    return retry;
  }
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
    status: captureStatus(serverCapture),
    error:
      serverCapture?.["status"] === "failed"
        ? expenseErrorMessage(
            serverCapture["failure"],
            "Receipt analysis failed.",
          )
        : null,
    serverCapture,
    updatedAt: Date.now(),
  };
  await writeRow(row);
  return row;
}

export async function syncEmployeeExpenseCaptures(
  employeeId: string,
): Promise<void> {
  const rows = await listExpenseCaptureQueue(employeeId);
  for (const row of rows) {
    if (row.status === "queued" || row.status === "syncing") {
      await syncExpenseCapture(row.clientCaptureId);
    }
  }
}

export async function registerExpenseBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  try {
    const registration = await navigator.serviceWorker.ready;
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
