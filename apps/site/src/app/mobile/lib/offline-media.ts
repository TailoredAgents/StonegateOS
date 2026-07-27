export const MOBILE_MEDIA_QUEUE_EVENT = "stonegate:media-queue-change";
export const MOBILE_STORAGE_WARNING_EVENT = "stonegate:storage-warning";

const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 2;
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const LAST_EMPLOYEE_KEY = "stonegate:last-mobile-employee";
const SNAPSHOT_TTL_MS = 48 * 60 * 60 * 1000;
const STALE_QUEUE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ROW_LEASE_MS = 10 * 60 * 1000;
const VISIBLE_SYNC_RETRY_MS = 5 * 1000;
const API_FETCH_TIMEOUT_MS = 45 * 1000;
const OBJECT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const QUEUE_HEALTH_TIMEOUT_MS = 30 * 1000;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const STONEGATE_TIME_ZONE = "America/New_York";
const DEVICE_ID_KEY = "mobileDeviceId";
const QUEUE_HEALTH_REFRESH_MS = 5 * 60 * 1000;
const QUEUE_HEALTH_FAILURE_BACKOFF_MS = 60 * 1000;
const QUEUE_BROADCAST_CHANNEL = "stonegate-mobile-media-queue";

export const MOBILE_STALE_QUEUE_MS = STALE_QUEUE_MS;

export type OfflinePaymentSummary = {
  status:
    | "unknown"
    | "unpaid"
    | "partial"
    | "paid"
    | "refunded"
    | "needs_review";
  jobTotalCents: number | null;
  paidTowardJobCents: number;
  tipCents: number;
  refundedCents: number;
  balanceCents: number | null;
  activeAttemptId: string | null;
  latestReceiptUrl: string | null;
};

export type OfflineAppointmentSnapshot = {
  key: string;
  employeeId: string;
  appointmentId: string;
  dayKey: string;
  contactName: string;
  address: string | null;
  start: string;
  end: string;
  status: string | null;
  canCaptureMedia: boolean;
  quotedScopeText: string | null;
  mediaSummary: {
    readyCount: number;
    pendingCount: number;
    coverMediaId: string | null;
    needsScope: boolean;
  };
  paymentSummary: OfflinePaymentSummary | null;
  savedAt: number;
  expiresAt: number;
};

export type OfflineMediaRecord = {
  key: string;
  employeeId: string;
  appointmentId: string;
  mediaId: string;
  caption: string | null;
  source: string | null;
  isCover: boolean;
  orderIndex: number;
  contentType: string;
  blob: Blob;
  savedAt: number;
};

export type QueuedMediaUpload = {
  clientId: string;
  employeeId: string;
  appointmentId: string;
  filename: string;
  contentType: string;
  byteCount: number;
  checksumSha256: string;
  caption: string | null;
  quotedScopeText: string | null;
  blob: Blob;
  capturedOffline: boolean;
  status: "queued" | "uploading" | "finalizing" | "failed";
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
};

export type QueueSummary = {
  total: number;
  uploading: number;
  failed: number;
  stale: number;
};

export type PersistentStorageState =
  | "granted"
  | "denied"
  | "unsupported"
  | "error";

type UploadIntent = {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  alreadyCompleted: boolean;
  processing: boolean;
};

const queueHealthReports = new Map<
  string,
  { fingerprint: string; reportedAt: number }
>();
const queueHealthFailuresUntil = new Map<string, number>();
const queueHealthInFlight = new Map<string, Promise<boolean>>();
const pendingQueueSyncEmployees = new Set<string>();
const visibleSyncRetryTimers = new Map<string, number>();
let queueBroadcastChannel: BroadcastChannel | null = null;

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function timedFetch<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return await consume(response);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return timedFetch(input, init, timeoutMs, (response) =>
    Promise.resolve(response),
  );
}

function fetchJsonWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload: unknown }> {
  return timedFetch(input, init, timeoutMs, async (response) => {
    let payload: unknown = null;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    return { response, payload };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexed_db_error"));
  });
}

function handleRequestResult<T, R>(
  request: IDBRequest<T>,
  handle: (result: T) => R,
): Promise<R> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      try {
        resolve(handle(request.result));
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The transaction may already be aborting.
        }
        reject(
          error instanceof Error
            ? error
            : new Error("indexed_db_callback_error"),
        );
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("indexed_db_error"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () =>
        reject(transaction.error ?? new Error("indexed_db_transaction_error")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          transaction.error ?? new Error("indexed_db_transaction_aborted"),
        ),
      { once: true },
    );
  });
  void completion.catch(() => undefined);
  return completion;
}

function getQueueBroadcastChannel(): BroadcastChannel | null {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return null;
  }
  if (!queueBroadcastChannel) {
    queueBroadcastChannel = new BroadcastChannel(QUEUE_BROADCAST_CHANNEL);
    queueBroadcastChannel.addEventListener("message", (event) => {
      const data =
        typeof event.data === "object" && event.data !== null
          ? (event.data as Record<string, unknown>)
          : null;
      const employeeId =
        typeof data?.["employeeId"] === "string" ? data["employeeId"] : null;
      if (data?.["requestSync"] === true && employeeId) {
        pendingQueueSyncEmployees.add(employeeId);
      }
      window.dispatchEvent(
        new CustomEvent(MOBILE_MEDIA_QUEUE_EVENT, {
          detail: {
            employeeId,
            requestSync: data?.["requestSync"] === true,
          },
        }),
      );
    });
  }
  return queueBroadcastChannel;
}

getQueueBroadcastChannel();

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexed_db_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        const store = database.createObjectStore(SNAPSHOT_STORE, {
          keyPath: "key",
        });
        store.createIndex("employeeId", "employeeId", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        const store = database.createObjectStore(MEDIA_STORE, {
          keyPath: "key",
        });
        store.createIndex("employeeId", "employeeId", { unique: false });
        store.createIndex("appointmentId", "appointmentId", {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        const store = database.createObjectStore(QUEUE_STORE, {
          keyPath: "clientId",
        });
        store.createIndex("employeeId", "employeeId", { unique: false });
        store.createIndex("appointmentId", "appointmentId", {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, {
          keyPath: "key",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexed_db_open_failed"));
  });
}

function snapshotKey(employeeId: string, appointmentId: string): string {
  return `${employeeId}:${appointmentId}`;
}

function mediaKey(
  employeeId: string,
  appointmentId: string,
  mediaId: string,
): string {
  return `${employeeId}:${appointmentId}:${mediaId}`;
}

export function stonegateDayKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STONEGATE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day
    ? `${year}-${month}-${day}`
    : value.toISOString().slice(0, 10);
}

function snapshotDayKey(
  snapshot: Pick<OfflineAppointmentSnapshot, "dayKey" | "start">,
): string {
  if (snapshot.dayKey) return snapshot.dayKey;
  const start = new Date(snapshot.start);
  return Number.isNaN(start.getTime()) ? "" : stonegateDayKey(start);
}

function deleteCachedMediaForAppointment(
  store: IDBObjectStore,
  employeeId: string,
  appointmentId: string,
): Promise<void> {
  const traversal = new Promise<void>((resolve, reject) => {
    const request = store
      .index("appointmentId")
      .openCursor(IDBKeyRange.only(appointmentId));
    request.onerror = () =>
      reject(request.error ?? new Error("indexed_db_cursor_error"));
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const row = cursor.value as OfflineMediaRecord;
        if (row.employeeId === employeeId) cursor.delete();
        cursor.continue();
      } catch (error) {
        try {
          store.transaction.abort();
        } catch {
          // The transaction may already be aborting.
        }
        reject(
          error instanceof Error ? error : new Error("indexed_db_cursor_error"),
        );
      }
    };
  });
  void traversal.catch(() => undefined);
  return traversal;
}

export function rememberMobileEmployee(employeeId: string): void {
  try {
    localStorage.setItem(LAST_EMPLOYEE_KEY, employeeId);
  } catch {
    // Private browsing can deny localStorage; IndexedDB may still work.
  }
}

export function getRememberedMobileEmployee(): string | null {
  try {
    return localStorage.getItem(LAST_EMPLOYEE_KEY);
  } catch {
    return null;
  }
}

export function clearActiveOfflineIdentity(): Promise<void> {
  try {
    localStorage.removeItem(LAST_EMPLOYEE_KEY);
  } catch {
    // The server-side logout still clears the authenticated session.
  }
  return openDatabase()
    .then(async (database) => {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const completion = transactionDone(transaction);
      transaction.objectStore(METADATA_STORE).delete("activeEmployeeId");
      await completion;
      database.close();
    })
    .catch(() => undefined);
}

export async function saveAppointmentSnapshots(
  employeeId: string,
  dayKey: string,
  snapshots: Array<
    Omit<
      OfflineAppointmentSnapshot,
      "key" | "employeeId" | "savedAt" | "expiresAt"
    >
  >,
  options?: { authoritative?: boolean },
): Promise<void> {
  const database = await openDatabase();
  const now = Date.now();
  const transaction = database.transaction(
    [SNAPSHOT_STORE, MEDIA_STORE, METADATA_STORE],
    "readwrite",
  );
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(SNAPSHOT_STORE);
  const incomingAppointmentIds = new Set(
    snapshots.map((snapshot) => snapshot.appointmentId),
  );
  const mediaStore = transaction.objectStore(MEDIA_STORE);
  const mediaCleanup = await handleRequestResult(
    store.index("employeeId").getAll(employeeId),
    (existing) => {
      const cleanup: Promise<void>[] = [];
      for (const row of existing as OfflineAppointmentSnapshot[]) {
        const expired = row.expiresAt <= now;
        const absentFromAuthoritativeToday =
          options?.authoritative === true &&
          snapshotDayKey(row) === dayKey &&
          !incomingAppointmentIds.has(row.appointmentId);
        if (!expired && !absentFromAuthoritativeToday) continue;
        store.delete(row.key);
        cleanup.push(
          deleteCachedMediaForAppointment(
            mediaStore,
            employeeId,
            row.appointmentId,
          ),
        );
      }

      for (const snapshot of snapshots) {
        store.put({
          ...snapshot,
          key: snapshotKey(employeeId, snapshot.appointmentId),
          employeeId,
          dayKey,
          savedAt: now,
          expiresAt: now + SNAPSHOT_TTL_MS,
        } satisfies OfflineAppointmentSnapshot);
      }
      transaction.objectStore(METADATA_STORE).put({
        key: "activeEmployeeId",
        value: employeeId,
        updatedAt: now,
      });
      return cleanup;
    },
  );
  await Promise.all([...mediaCleanup, completion]);
  database.close();
  rememberMobileEmployee(employeeId);
  void checkStoragePressure();
}

export async function getAppointmentSnapshots(
  employeeId: string,
  dayKey = stonegateDayKey(),
): Promise<OfflineAppointmentSnapshot[]> {
  const database = await openDatabase();
  const transaction = database.transaction(
    [SNAPSHOT_STORE, MEDIA_STORE],
    "readwrite",
  );
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(SNAPSHOT_STORE);
  const now = Date.now();
  const mediaStore = transaction.objectStore(MEDIA_STORE);
  const { rows, mediaCleanup } = await handleRequestResult(
    store.index("employeeId").getAll(employeeId),
    (result) => {
      const rows = result as OfflineAppointmentSnapshot[];
      const mediaCleanup: Promise<void>[] = [];
      for (const row of rows) {
        if (row.expiresAt > now) continue;
        store.delete(row.key);
        mediaCleanup.push(
          deleteCachedMediaForAppointment(
            mediaStore,
            employeeId,
            row.appointmentId,
          ),
        );
      }
      return { rows, mediaCleanup };
    },
  );
  await Promise.all([...mediaCleanup, completion]);
  database.close();
  void checkStoragePressure();
  return rows
    .filter((row) => row.expiresAt > now && snapshotDayKey(row) === dayKey)
    .map((row) => ({ ...row, dayKey: snapshotDayKey(row) }))
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

export async function cacheAppointmentMedia(
  employeeId: string,
  appointmentId: string,
  items: Array<{
    id: string;
    caption?: string | null;
    source?: string | null;
    isCover?: boolean;
    orderIndex?: number;
    displayUrl?: string | null;
    contentType?: string | null;
  }>,
): Promise<void> {
  const cacheable = items.filter((item) => item.displayUrl);
  const currentMediaIds = new Set(items.map((item) => item.id));
  const records = (
    await Promise.all(
      cacheable.map(async (item): Promise<OfflineMediaRecord | null> => {
        const url = item.displayUrl;
        if (!url) return null;
        try {
          const response = await fetch(url, {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok) return null;
          const blob = await response.blob();
          return {
            key: mediaKey(employeeId, appointmentId, item.id),
            employeeId,
            appointmentId,
            mediaId: item.id,
            caption: item.caption ?? null,
            source: item.source ?? null,
            isCover: Boolean(item.isCover),
            orderIndex: item.orderIndex ?? 0,
            contentType:
              item.contentType ?? blob.type ?? "application/octet-stream",
            blob,
            savedAt: Date.now(),
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((record): record is OfflineMediaRecord => record !== null);

  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(MEDIA_STORE);
  for (const record of records) store.put(record);
  const traversal = new Promise<void>((resolve, reject) => {
    const request = store
      .index("appointmentId")
      .openCursor(IDBKeyRange.only(appointmentId));
    request.onerror = () =>
      reject(request.error ?? new Error("indexed_db_cursor_error"));
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const row = cursor.value as OfflineMediaRecord;
        if (
          row.employeeId === employeeId &&
          !currentMediaIds.has(row.mediaId)
        ) {
          cursor.delete();
        }
        cursor.continue();
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be aborting.
        }
        reject(
          error instanceof Error ? error : new Error("indexed_db_cursor_error"),
        );
      }
    };
  });
  await Promise.all([traversal, completion]);
  database.close();
  void checkStoragePressure();
}

export async function getCachedAppointmentMedia(
  employeeId: string,
  appointmentId: string,
): Promise<OfflineMediaRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const completion = transactionDone(transaction);
  const rows = (await requestResult(
    transaction
      .objectStore(MEDIA_STORE)
      .index("appointmentId")
      .getAll(appointmentId),
  )) as OfflineMediaRecord[];
  await completion;
  database.close();
  return rows
    .filter((row) => row.employeeId === employeeId)
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function detectImageType(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytesToHex(bytes.slice(0, 4)) === "52494646" &&
    bytesToHex(bytes.slice(8, 12)) === "57454250"
  ) {
    return "image/webp";
  }
  const boxType = new TextDecoder("ascii").decode(bytes.slice(4, 12));
  if (
    boxType.startsWith("ftyp") &&
    /(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)/u.test(
      new TextDecoder("ascii").decode(bytes),
    )
  ) {
    return "image/heic";
  }
  throw new Error("unsupported_image");
}

async function canvasBlob(
  canvas: HTMLCanvasElement,
  contentType: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("image_encode_failed")),
      contentType,
      quality,
    );
  });
}

async function loadBrowserImage(file: File): Promise<{
  image: HTMLImageElement;
  objectUrl: string;
}> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image_decode_failed"));
      image.src = objectUrl;
    });
    return { image, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export async function normalizeImageForQueue(file: File): Promise<{
  blob: Blob;
  filename: string;
  contentType: string;
  checksumSha256: string;
}> {
  if (file.size <= 0) throw new Error("empty_image");
  if (file.size > MAX_INPUT_BYTES) throw new Error("image_too_large");
  await detectImageType(file);

  let bitmap: ImageBitmap | null = null;
  let browserImage: Awaited<ReturnType<typeof loadBrowserImage>> | null = null;
  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    }
  } catch {
    // Safari can render camera HEIC files through an HTMLImageElement even on
    // versions where createImageBitmap rejects the same file.
  }
  if (!bitmap) {
    browserImage = await loadBrowserImage(file);
  }
  const source = bitmap ?? browserImage?.image;
  const sourceWidth = bitmap?.width ?? browserImage?.image.naturalWidth ?? 0;
  const sourceHeight = bitmap?.height ?? browserImage?.image.naturalHeight ?? 0;
  if (!source) throw new Error("image_decode_failed");
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    sourceWidth * sourceHeight > 60_000_000
  ) {
    bitmap?.close();
    if (browserImage) URL.revokeObjectURL(browserImage.objectUrl);
    throw new Error("unsafe_image_dimensions");
  }

  const scale = Math.min(1, 1920 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    bitmap?.close();
    if (browserImage) URL.revokeObjectURL(browserImage.objectUrl);
    throw new Error("canvas_unavailable");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  bitmap?.close();
  if (browserImage) URL.revokeObjectURL(browserImage.objectUrl);

  const blob = await canvasBlob(canvas, "image/jpeg", 0.84);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  const baseName = file.name.replace(/\.[^.]+$/u, "").slice(0, 120) || "photo";
  return {
    blob,
    filename: `${baseName}.jpg`,
    contentType: "image/jpeg",
    checksumSha256: bytesToHex(new Uint8Array(digest)),
  };
}

export async function queueMediaUpload(input: {
  employeeId: string;
  appointmentId: string;
  file: File;
  capturedOffline: boolean;
  caption?: string | null;
  quotedScopeText?: string | null;
}): Promise<QueuedMediaUpload> {
  const normalized = await normalizeImageForQueue(input.file);
  const now = Date.now();
  const row: QueuedMediaUpload = {
    clientId: crypto.randomUUID(),
    employeeId: input.employeeId,
    appointmentId: input.appointmentId,
    filename: normalized.filename,
    contentType: normalized.contentType,
    byteCount: normalized.blob.size,
    checksumSha256: normalized.checksumSha256,
    caption: input.caption?.trim().slice(0, 500) || null,
    quotedScopeText: input.quotedScopeText?.trim().slice(0, 4_000) || null,
    blob: normalized.blob,
    capturedOffline: input.capturedOffline,
    status: "queued",
    error: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(QUEUE_STORE).put(row);
  await completion;
  database.close();
  dispatchQueueChange(row.employeeId, true);
  void registerMediaBackgroundSync();
  void checkStoragePressure();
  return row;
}

export async function listEmployeeQueue(
  employeeId: string,
): Promise<QueuedMediaUpload[]> {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readonly");
  const completion = transactionDone(transaction);
  const rows = (await requestResult(
    transaction.objectStore(QUEUE_STORE).index("employeeId").getAll(employeeId),
  )) as QueuedMediaUpload[];
  await completion;
  database.close();
  return rows.sort((left, right) => left.createdAt - right.createdAt);
}

async function getOrCreateMobileDeviceId(): Promise<string> {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  const deviceId = await handleRequestResult(
    store.get(DEVICE_ID_KEY),
    (result) => {
      const existing = result as
        | { key: typeof DEVICE_ID_KEY; value?: unknown }
        | undefined;
      const deviceId =
        typeof existing?.value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          existing.value,
        )
          ? existing.value
          : crypto.randomUUID();
      if (deviceId !== existing?.value) {
        store.put({
          key: DEVICE_ID_KEY,
          value: deviceId,
          updatedAt: Date.now(),
        });
      }
      return deviceId;
    },
  );
  await completion;
  database.close();
  return deviceId;
}

async function performOfflineQueueHealthReport(
  employeeId: string,
): Promise<boolean> {
  try {
    const rows = await listEmployeeQueue(employeeId);
    const failedCount = rows.filter((row) => row.status === "failed").length;
    const oldestCreatedAt = rows.reduce<number | null>(
      (oldest, row) =>
        oldest === null || row.createdAt < oldest ? row.createdAt : oldest,
      null,
    );
    const fingerprint = `${rows.length}:${failedCount}:${oldestCreatedAt ?? ""}`;
    const lastReport = queueHealthReports.get(employeeId);
    const now = Date.now();
    if (
      lastReport?.fingerprint === fingerprint &&
      lastReport.reportedAt > now - QUEUE_HEALTH_REFRESH_MS
    ) {
      return true;
    }

    const response = await fetchWithTimeout(
      "/api/mobile/offline-media-queue-health",
      {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: await getOrCreateMobileDeviceId(),
          queuedCount: rows.length,
          failedCount,
          oldestQueuedAt:
            oldestCreatedAt === null
              ? null
              : new Date(oldestCreatedAt).toISOString(),
          reportedAt: new Date(now).toISOString(),
        }),
      },
      QUEUE_HEALTH_TIMEOUT_MS,
    );
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

export function reportOfflineQueueHealth(employeeId: string): Promise<boolean> {
  const active = queueHealthInFlight.get(employeeId);
  if (active) return active;
  if ((queueHealthFailuresUntil.get(employeeId) ?? 0) > Date.now()) {
    return Promise.resolve(false);
  }

  const promise = performOfflineQueueHealthReport(employeeId);
  const settled = promise.finally(() => {
    if (queueHealthInFlight.get(employeeId) === settled) {
      queueHealthInFlight.delete(employeeId);
    }
  });
  queueHealthInFlight.set(employeeId, settled);
  return settled;
}

export async function getAppointmentQueue(
  employeeId: string,
  appointmentId: string,
): Promise<QueuedMediaUpload[]> {
  const rows = await listEmployeeQueue(employeeId);
  return rows.filter((row) => row.appointmentId === appointmentId);
}

export async function discardQueuedMedia(clientId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(QUEUE_STORE).delete(clientId);
  await completion;
  database.close();
  dispatchQueueChange();
  void checkStoragePressure();
}

async function discardUploadedMedia(
  clientIds: readonly string[],
  employeeId: string,
): Promise<void> {
  if (!clientIds.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(QUEUE_STORE);
  for (const clientId of clientIds) store.delete(clientId);
  try {
    await completion;
  } finally {
    database.close();
  }
  dispatchQueueChange(employeeId);
  void checkStoragePressure();
}

export async function retryQueuedMedia(clientId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(QUEUE_STORE);
  const row = await handleRequestResult(store.get(clientId), (result) => {
    const row = result as QueuedMediaUpload | undefined;
    if (row) {
      store.put({
        ...row,
        status: "queued",
        error: null,
        updatedAt: Date.now(),
      } satisfies QueuedMediaUpload);
    }
    return row;
  });
  await completion;
  database.close();
  if (row) dispatchQueueChange(row.employeeId, true);
}

export async function getQueueSummary(
  employeeId: string,
): Promise<QueueSummary> {
  const rows = await listEmployeeQueue(employeeId);
  const staleBefore = Date.now() - STALE_QUEUE_MS;
  return {
    total: rows.length,
    uploading: rows.filter(
      (row) => row.status === "uploading" || row.status === "finalizing",
    ).length,
    failed: rows.filter((row) => row.status === "failed").length,
    stale: rows.filter((row) => row.createdAt < staleBefore).length,
  };
}

export function isInterruptedQueueRow(
  row: QueuedMediaUpload,
  now = Date.now(),
): boolean {
  return (
    (row.status === "uploading" || row.status === "finalizing") &&
    row.updatedAt <= now - UPLOAD_ROW_LEASE_MS
  );
}

function dispatchQueueChange(employeeId?: string, requestSync = false): void {
  if (requestSync && employeeId) {
    pendingQueueSyncEmployees.add(employeeId);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(MOBILE_MEDIA_QUEUE_EVENT, {
        detail: { employeeId: employeeId ?? null, requestSync },
      }),
    );
    getQueueBroadcastChannel()?.postMessage({
      changedAt: Date.now(),
      employeeId: employeeId ?? null,
      requestSync,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseUploadIntent(payload: unknown): UploadIntent | null {
  const root = asRecord(payload);
  const intents = root?.["intents"];
  const uploads = root?.["uploads"];
  const candidates: unknown[] = [
    ...(Array.isArray(intents) ? (intents as unknown[]) : []),
    ...(Array.isArray(uploads) ? (uploads as unknown[]) : []),
    root?.["intent"],
  ];
  const candidate = candidates.map(asRecord).find(Boolean);
  if (!candidate) return null;
  const mediaId =
    typeof candidate["mediaId"] === "string"
      ? candidate["mediaId"]
      : typeof candidate["id"] === "string"
        ? candidate["id"]
        : "";
  const uploadUrl =
    typeof candidate["uploadUrl"] === "string"
      ? candidate["uploadUrl"]
      : typeof candidate["url"] === "string"
        ? candidate["url"]
        : "";
  const rawHeaders = asRecord(
    candidate["uploadHeaders"] ??
      candidate["headers"] ??
      candidate["requiredHeaders"],
  );
  const headers = Object.fromEntries(
    Object.entries(rawHeaders ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const alreadyCompleted =
    candidate["alreadyCompleted"] === true || candidate["status"] === "ready";
  const processing = !alreadyCompleted && candidate["status"] === "processing";
  if (!mediaId || (!uploadUrl && !alreadyCompleted && !processing)) return null;
  return { mediaId, uploadUrl, headers, alreadyCompleted, processing };
}

function errorFromPayload(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  for (const key of ["message", "error", "errorCode"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

type QueueUploadFailureMode = "retry" | "auth_paused" | "terminal";

class QueueUploadError extends Error {
  constructor(
    message: string,
    readonly mode: QueueUploadFailureMode,
  ) {
    super(message);
    this.name = "QueueUploadError";
  }
}

function responseFailure(
  response: Response,
  payload: unknown,
  fallback: string,
): QueueUploadError {
  const message = errorFromPayload(payload, fallback);
  const record = asRecord(payload);
  const errorCode = ["errorCode", "error", "code"]
    .map((key) => record?.[key])
    .find((value): value is string => typeof value === "string");
  const terminalErrors = new Set([
    "appointment_media_writes_disabled",
    "media_writes_disabled",
    "mobile_offline_media_disabled",
    "offline_media_disabled",
    "forbidden",
    "unauthorized",
  ]);
  let mode: QueueUploadFailureMode = "terminal";
  if (response.status === 401) {
    mode = "auth_paused";
  } else if (
    response.status !== 403 &&
    !terminalErrors.has(errorCode ?? message) &&
    (response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      (response.status === 409 &&
        (errorCode === "media_processing" || message === "media_processing")) ||
      response.status >= 500)
  ) {
    mode = "retry";
  }
  return new QueueUploadError(message, mode);
}

function uploadFailureMode(error: unknown): QueueUploadFailureMode {
  if (isAbortError(error) || error instanceof TypeError) return "retry";
  return error instanceof QueueUploadError ? error.mode : "terminal";
}

function isReadyCompletion(payload: unknown, mediaId: string): boolean {
  const root = asRecord(payload);
  const media = asRecord(root?.["media"]);
  return (
    root?.["ok"] === true &&
    media?.["id"] === mediaId &&
    media["status"] === "ready"
  );
}

async function materializeQueuedUploadBody(
  row: QueuedMediaUpload,
): Promise<ArrayBuffer> {
  if (
    !row.blob ||
    typeof row.blob.arrayBuffer !== "function" ||
    !Number.isSafeInteger(row.byteCount) ||
    row.byteCount <= 0
  ) {
    throw new QueueUploadError("queued_media_blob_invalid", "retry");
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await row.blob.arrayBuffer();
  } catch {
    throw new QueueUploadError("queued_media_blob_read_failed", "retry");
  }
  if (bytes.byteLength !== row.byteCount) {
    throw new QueueUploadError("queued_media_blob_size_mismatch", "retry");
  }
  return bytes;
}

async function uploadQueueRow(
  row: QueuedMediaUpload,
): Promise<"success" | QueueUploadFailureMode> {
  try {
    const { response: intentResponse, payload: intentPayload } =
      await fetchJsonWithTimeout(
        `/api/mobile/appointments/${encodeURIComponent(row.appointmentId)}/media/upload-intents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            uploadMode: row.capturedOffline ? "offline_queue" : "direct_mobile",
            ...(row.quotedScopeText
              ? { quotedScopeText: row.quotedScopeText }
              : {}),
            files: [
              {
                clientId: row.clientId,
                filename: row.filename,
                contentType: row.contentType,
                mimeType: row.contentType,
                byteLength: row.byteCount,
                checksumSha256: row.checksumSha256,
                caption: row.caption,
              },
            ],
          }),
        },
        API_FETCH_TIMEOUT_MS,
      );
    if (!intentResponse.ok) {
      throw responseFailure(
        intentResponse,
        intentPayload,
        "upload_intent_failed",
      );
    }
    const intent = parseUploadIntent(intentPayload);
    if (!intent) throw new Error("invalid_upload_intent");
    if (intent.processing) {
      throw new QueueUploadError("media_processing", "retry");
    }

    if (!intent.alreadyCompleted) {
      // WebKit can acknowledge a fetch that streams an IndexedDB-backed Blob
      // while sending a zero-byte body. Materializing it gives fetch a concrete
      // length and preserves the queue when the stored bytes are incomplete.
      const uploadBody = await materializeQueuedUploadBody(row);
      const uploadResponse = await fetchWithTimeout(
        intent.uploadUrl,
        {
          method: "PUT",
          headers: {
            "content-type": row.contentType,
            ...intent.headers,
          },
          body: uploadBody,
        },
        OBJECT_UPLOAD_TIMEOUT_MS,
      );
      if (!uploadResponse.ok) {
        throw responseFailure(uploadResponse, null, "object_upload_failed");
      }
    }

    const { response: completeResponse, payload: completePayload } =
      await fetchJsonWithTimeout(
        `/api/mobile/appointment-media/${encodeURIComponent(intent.mediaId)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checksumSha256: row.checksumSha256,
          }),
        },
        API_FETCH_TIMEOUT_MS,
      );
    if (!completeResponse.ok) {
      throw responseFailure(
        completeResponse,
        completePayload,
        "media_finalize_failed",
      );
    }
    if (!isReadyCompletion(completePayload, intent.mediaId)) {
      throw new QueueUploadError("invalid_media_finalize_response", "retry");
    }
    return "success";
  } catch (error) {
    return uploadFailureMode(error);
  }
}

let activeSync: {
  employeeId: string;
  promise: Promise<void>;
  rerunRequested: boolean;
} | null = null;

function scheduleVisibleSyncRetry(
  employeeId: string,
  delayMs = VISIBLE_SYNC_RETRY_MS,
): void {
  if (typeof window === "undefined" || visibleSyncRetryTimers.has(employeeId)) {
    return;
  }
  const timer = window.setTimeout(() => {
    visibleSyncRetryTimers.delete(employeeId);
    if (document.visibilityState !== "visible") return;
    void syncQueuedMedia(employeeId).catch(() => undefined);
  }, delayMs);
  visibleSyncRetryTimers.set(employeeId, timer);
}

export function registerMediaBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve();
  }
  return navigator.serviceWorker.ready
    .then((registration) => {
      const backgroundRegistration =
        registration as ServiceWorkerRegistration & {
          sync?: { register(tag: string): Promise<void> };
        };
      return backgroundRegistration.sync?.register("stonegate-media-sync");
    })
    .then(() => undefined)
    .catch(() => undefined);
}

export function syncQueuedMedia(employeeId: string): Promise<void> {
  if (activeSync?.employeeId === employeeId) {
    if (pendingQueueSyncEmployees.has(employeeId)) {
      activeSync.rerunRequested = true;
    }
    return activeSync.promise;
  }
  if (activeSync) {
    return activeSync.promise
      .catch(() => undefined)
      .then(() => syncQueuedMedia(employeeId));
  }

  const syncState = {
    employeeId,
    promise: Promise.resolve(),
    rerunRequested: false,
  };
  const promise = (async () => {
    pendingQueueSyncEmployees.delete(employeeId);
    let initialRows: QueuedMediaUpload[];
    try {
      initialRows = await listEmployeeQueue(employeeId);
    } catch {
      void registerMediaBackgroundSync();
      scheduleVisibleSyncRetry(employeeId);
      return;
    }
    const hasSyncableRows = initialRows.some(
      (row) => row.status === "queued" || isInterruptedQueueRow(row),
    );
    if (!hasSyncableRows && !pendingQueueSyncEmployees.has(employeeId)) {
      syncState.rerunRequested = false;
      return;
    }

    let meResponse: Response;
    let mePayload: unknown;
    try {
      const result = await fetchJsonWithTimeout(
        "/api/mobile/me",
        { cache: "no-store" },
        API_FETCH_TIMEOUT_MS,
      );
      meResponse = result.response;
      mePayload = result.payload;
    } catch {
      void registerMediaBackgroundSync();
      scheduleVisibleSyncRetry(employeeId);
      return;
    }
    if (!meResponse.ok) {
      if (
        meResponse.status === 408 ||
        meResponse.status === 425 ||
        meResponse.status === 429 ||
        meResponse.status >= 500
      ) {
        void registerMediaBackgroundSync();
        scheduleVisibleSyncRetry(employeeId);
      } else {
        pendingQueueSyncEmployees.delete(employeeId);
        syncState.rerunRequested = false;
      }
      return;
    }
    const teamMember = asRecord(asRecord(mePayload)?.["teamMember"]);
    if (teamMember?.["id"] !== employeeId) {
      pendingQueueSyncEmployees.delete(employeeId);
      syncState.rerunRequested = false;
      return;
    }

    const rows = initialRows.filter(
      (row) => row.status === "queued" || isInterruptedQueueRow(row),
    );
    const completedClientIds: string[] = [];
    let retryableFailure = false;
    for (const row of rows) {
      const outcome = await uploadQueueRow(row);
      if (outcome === "success") {
        completedClientIds.push(row.clientId);
      } else if (outcome === "retry") {
        retryableFailure = true;
      } else if (outcome === "auth_paused") {
        break;
      }
    }
    if (completedClientIds.length) {
      await discardUploadedMedia(completedClientIds, employeeId).catch(
        () => undefined,
      );
    }
    if (retryableFailure) {
      void registerMediaBackgroundSync();
      scheduleVisibleSyncRetry(employeeId);
    }
  })().catch(() => {
    void registerMediaBackgroundSync();
    scheduleVisibleSyncRetry(employeeId);
  });

  const settled = promise.finally(() => {
    if (activeSync?.promise !== settled) return;
    const shouldRerun =
      activeSync.rerunRequested || pendingQueueSyncEmployees.has(employeeId);
    activeSync = null;
    if (shouldRerun) scheduleVisibleSyncRetry(employeeId, 0);
  });
  syncState.promise = settled;
  activeSync = syncState;
  return settled;
}

export async function requestPersistentStorage(): Promise<PersistentStorageState> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return "unsupported";
  }
  try {
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch {
    return "error";
  }
}

export async function checkStoragePressure(): Promise<number | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null;
  }
  try {
    const estimate = await navigator.storage.estimate();
    if (!estimate.quota || estimate.usage == null) return null;
    const ratio = estimate.usage / estimate.quota;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(MOBILE_STORAGE_WARNING_EVENT, { detail: { ratio } }),
      );
    }
    return ratio;
  } catch {
    return null;
  }
}
