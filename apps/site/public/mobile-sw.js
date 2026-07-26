const SHELL_CACHE = "stonegate-mobile-shell-v4";
const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 2;
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const UPLOAD_ROW_LEASE_MS = 10 * 60 * 1000;
const SYNC_COORDINATOR_LEASE_MS = 30 * 1000;
const SYNC_COORDINATOR_HEARTBEAT_MS = 5 * 1000;
const API_FETCH_TIMEOUT_MS = 45 * 1000;
const OBJECT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const QUEUE_HEALTH_TIMEOUT_MS = 30 * 1000;
const SYNC_LEASE_KEY = "mediaSyncLease";
const SYNC_LEASE_VERSION = 3;
const DEVICE_ID_KEY = "mobileDeviceId";
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/favicon.png",
];
let workerSyncOwner = null;
let workerActiveSync = null;

function workerIsAbortError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function workerTimedFetch(input, init, timeoutMs, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

function workerFetchWithTimeout(input, init, timeoutMs) {
  return workerTimedFetch(input, init, timeoutMs, (response) =>
    Promise.resolve(response),
  );
}

function workerFetchJsonWithTimeout(input, init, timeoutMs) {
  return workerTimedFetch(input, init, timeoutMs, async (response) => {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (workerIsAbortError(error)) throw error;
    }
    return { response, payload };
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_URLS);
      const offlineResponse = await fetch("/mobile/offline");
      await cache.put("/mobile/offline", offlineResponse.clone());
      const html = await offlineResponse.text();
      const assetUrls = Array.from(
        html.matchAll(/(?:src|href)="([^"]+)"/gu),
        (match) => match[1],
      ).filter((url) => url?.startsWith("/_next/static/"));
      await Promise.allSettled(
        assetUrls.map((url) => (url ? cache.add(url) : Promise.resolve())),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("stonegate-mobile-shell-") &&
                key !== SHELL_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    request.method === "GET" &&
    (url.pathname.startsWith("/_next/static/") ||
      SHELL_URLS.includes(url.pathname))
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              void caches
                .open(SHELL_CACHE)
                .then((cache) => cache.put(request, response.clone()));
            }
            return response;
          }),
      ),
    );
    return;
  }
  if (request.mode !== "navigate" || !url.pathname.startsWith("/mobile"))
    return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (
        (await cache.match("/mobile/offline")) ||
        new Response("StonegateOS is offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      );
    }),
  );
});

function openDatabase() {
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
        store.createIndex("appointmentId", "appointmentId", { unique: false });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, {
          keyPath: "key",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("db_open_failed"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("db_error"));
  });
}

function transactionDone(transaction) {
  const completion = new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () => reject(transaction.error || new Error("db_transaction_failed")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error || new Error("db_transaction_aborted")),
      { once: true },
    );
  });
  void completion.catch(() => undefined);
  return completion;
}

async function getQueue() {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readonly");
  const completion = transactionDone(transaction);
  const rows = await requestResult(
    transaction.objectStore(QUEUE_STORE).getAll(),
  );
  await completion;
  database.close();
  return rows;
}

async function getActiveEmployeeId() {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readonly");
  const completion = transactionDone(transaction);
  const row = await requestResult(
    transaction.objectStore(METADATA_STORE).get("activeEmployeeId"),
  );
  await completion;
  database.close();
  return typeof row?.value === "string" ? row.value : null;
}

async function getOrCreateDeviceId() {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(DEVICE_ID_KEY));
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
  await completion;
  database.close();
  return deviceId;
}

async function reportQueueHealth(employeeId) {
  try {
    const rows = (await getQueue()).filter(
      (row) => row.employeeId === employeeId,
    );
    const failedCount = rows.filter((row) => row.status === "failed").length;
    const oldestQueuedAt = rows.reduce(
      (oldest, row) =>
        oldest === null || row.createdAt < oldest ? row.createdAt : oldest,
      null,
    );
    await workerFetchWithTimeout(
      "/api/mobile/offline-media-queue-health",
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: await getOrCreateDeviceId(),
          queuedCount: rows.length,
          failedCount,
          oldestQueuedAt:
            oldestQueuedAt === null
              ? null
              : new Date(oldestQueuedAt).toISOString(),
          reportedAt: new Date().toISOString(),
        }),
      },
      QUEUE_HEALTH_TIMEOUT_MS,
    );
  } catch {
    // The next foreground/visibility sync reports the queue again.
  }
}

async function acquireSyncLease(owner, employeeId) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  const now = Date.now();
  if (
    existing?.version === SYNC_LEASE_VERSION &&
    existing.expiresAt > now &&
    existing.owner !== owner
  ) {
    await completion;
    database.close();
    return false;
  }
  store.put({
    key: SYNC_LEASE_KEY,
    version: SYNC_LEASE_VERSION,
    owner,
    employeeId,
    heartbeatAt: now,
    expiresAt: now + SYNC_COORDINATOR_LEASE_MS,
  });
  await completion;
  database.close();
  return true;
}

async function renewSyncLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  if (existing?.version === SYNC_LEASE_VERSION && existing.owner === owner) {
    const now = Date.now();
    store.put({
      ...existing,
      heartbeatAt: now,
      expiresAt: now + SYNC_COORDINATOR_LEASE_MS,
    });
  }
  await completion;
  database.close();
  return existing?.version === SYNC_LEASE_VERSION && existing.owner === owner;
}

async function releaseSyncLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  if (existing?.version === SYNC_LEASE_VERSION && existing.owner === owner) {
    store.delete(SYNC_LEASE_KEY);
  }
  await completion;
  database.close();
}

async function reclaimInterruptedRows(employeeId) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(QUEUE_STORE);
  const rows = await requestResult(
    store.index("employeeId").getAll(employeeId),
  );
  const now = Date.now();
  for (const row of rows) {
    if (
      (row.status === "uploading" || row.status === "finalizing") &&
      row.updatedAt <= now - UPLOAD_ROW_LEASE_MS
    ) {
      store.put({
        ...row,
        status: "queued",
        error: "Previous upload was interrupted. Retrying safely.",
        updatedAt: now,
      });
    }
  }
  await completion;
  database.close();
}

async function putQueue(row) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(QUEUE_STORE).put(row);
  await completion;
  database.close();
}

async function deleteQueue(clientId) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(QUEUE_STORE).delete(clientId);
  await completion;
  database.close();
}

function firstIntent(payload) {
  const candidate =
    (Array.isArray(payload?.intents) && payload.intents[0]) ||
    (Array.isArray(payload?.uploads) && payload.uploads[0]) ||
    payload?.intent;
  if (!candidate || typeof candidate !== "object") return null;
  const mediaId = candidate.mediaId || candidate.id;
  const uploadUrl = candidate.uploadUrl || candidate.url;
  const uploadHeaders =
    candidate.uploadHeaders ||
    candidate.headers ||
    candidate.requiredHeaders ||
    {};
  const ready =
    candidate.alreadyCompleted === true || candidate.status === "ready";
  const processing = !ready && candidate.status === "processing";
  if (!mediaId || (!uploadUrl && !ready && !processing)) return null;
  return {
    mediaId,
    uploadUrl,
    uploadHeaders,
    ready,
    processing,
  };
}

class WorkerQueueUploadError extends Error {
  constructor(message, mode) {
    super(message);
    this.name = "WorkerQueueUploadError";
    this.mode = mode;
  }
}

function responseErrorMessage(payload, fallback) {
  for (const key of ["message", "error", "errorCode"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function workerResponseFailure(response, payload, fallback) {
  const message = responseErrorMessage(payload, fallback);
  const errorCode = ["errorCode", "error", "code"]
    .map((key) => payload?.[key])
    .find((value) => typeof value === "string");
  const terminalErrors = new Set([
    "appointment_media_writes_disabled",
    "media_writes_disabled",
    "mobile_offline_media_disabled",
    "offline_media_disabled",
    "forbidden",
    "unauthorized",
  ]);
  let mode = "terminal";
  if (response.status === 401) {
    mode = "auth_paused";
  } else if (
    response.status !== 403 &&
    !terminalErrors.has(errorCode || message) &&
    (response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      (response.status === 409 &&
        (errorCode === "media_processing" || message === "media_processing")) ||
      response.status >= 500)
  ) {
    mode = "retry";
  }
  return new WorkerQueueUploadError(message, mode);
}

function workerUploadFailureMode(error) {
  if (workerIsAbortError(error) || error instanceof TypeError) return "retry";
  return error instanceof WorkerQueueUploadError ? error.mode : "terminal";
}

async function uploadRow(row) {
  const working = {
    ...row,
    status: "uploading",
    error: null,
    attempts: (row.attempts || 0) + 1,
    updatedAt: Date.now(),
  };
  await putQueue(working);

  try {
    const { response: intentResponse, payload: intentPayload } =
      await workerFetchJsonWithTimeout(
        `/api/mobile/appointments/${encodeURIComponent(row.appointmentId)}/media/upload-intents`,
        {
          method: "POST",
          credentials: "include",
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
      throw workerResponseFailure(
        intentResponse,
        intentPayload,
        "upload_intent_failed",
      );
    }
    const intent = firstIntent(intentPayload);
    if (!intent) throw new Error("invalid_upload_intent");
    if (intent.processing) {
      throw new WorkerQueueUploadError("media_processing", "retry");
    }

    if (!intent.ready) {
      const objectResponse = await workerFetchWithTimeout(
        intent.uploadUrl,
        {
          method: "PUT",
          headers: {
            "content-type": row.contentType,
            ...intent.uploadHeaders,
          },
          body: row.blob,
        },
        OBJECT_UPLOAD_TIMEOUT_MS,
      );
      if (!objectResponse.ok) {
        throw workerResponseFailure(
          objectResponse,
          null,
          "object_upload_failed",
        );
      }
    }

    await putQueue({
      ...working,
      status: "finalizing",
      updatedAt: Date.now(),
    });
    const { response: completeResponse, payload: completePayload } =
      await workerFetchJsonWithTimeout(
        `/api/mobile/appointment-media/${encodeURIComponent(intent.mediaId)}/complete`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ checksumSha256: row.checksumSha256 }),
        },
        API_FETCH_TIMEOUT_MS,
      );
    if (!completeResponse.ok) {
      throw workerResponseFailure(
        completeResponse,
        completePayload,
        "media_finalize_failed",
      );
    }
    await deleteQueue(row.clientId);
    return "success";
  } catch (error) {
    const failureMode = workerUploadFailureMode(error);
    const queued = failureMode !== "terminal";
    await putQueue({
      ...working,
      status: queued ? "queued" : "failed",
      error: error instanceof Error ? error.message : "upload_failed",
      updatedAt: Date.now(),
    });
    return failureMode;
  }
}

async function performSyncQueue() {
  const activeEmployeeId = await getActiveEmployeeId();
  if (!activeEmployeeId) return;
  const { response: sessionResponse, payload: sessionPayload } =
    await workerFetchJsonWithTimeout(
      "/api/mobile/me",
      {
        credentials: "include",
        cache: "no-store",
      },
      API_FETCH_TIMEOUT_MS,
    );
  if (!sessionResponse.ok) {
    if (
      sessionResponse.status === 408 ||
      sessionResponse.status === 425 ||
      sessionResponse.status === 429 ||
      sessionResponse.status >= 500
    ) {
      throw new Error("media_sync_session_unavailable");
    }
    return;
  }
  if (sessionPayload?.teamMember?.id !== activeEmployeeId) return;

  workerSyncOwner ||= `worker:${crypto.randomUUID()}`;
  const owner = workerSyncOwner;
  if (!(await acquireSyncLease(owner, activeEmployeeId))) {
    throw new Error("media_sync_lease_busy");
  }

  let leaseActive = true;
  const heartbeat = setInterval(() => {
    void renewSyncLease(owner).then((renewed) => {
      leaseActive = renewed;
    });
  }, SYNC_COORDINATOR_HEARTBEAT_MS);
  let retryableFailures = 0;
  try {
    await reclaimInterruptedRows(activeEmployeeId);
    const attemptedClientIds = new Set();
    while (leaseActive) {
      const rows = (await getQueue()).filter(
        (row) =>
          row.employeeId === activeEmployeeId &&
          row.status === "queued" &&
          !attemptedClientIds.has(row.clientId),
      );
      if (!rows.length) break;

      let cursor = 0;
      const worker = async () => {
        while (cursor < rows.length && leaseActive) {
          const row = rows[cursor++];
          if (!row) continue;
          attemptedClientIds.add(row.clientId);
          leaseActive = await renewSyncLease(owner);
          if (!leaseActive) return;
          if ((await uploadRow(row)) === "retry") {
            retryableFailures += 1;
          }
        }
      };
      await Promise.all([worker(), worker()]);
    }
  } finally {
    clearInterval(heartbeat);
    await releaseSyncLease(owner);
    await reportQueueHealth(activeEmployeeId);
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clients) {
      client.postMessage({ type: "stonegate-media-sync-complete" });
    }
  }
  if (retryableFailures > 0) throw new Error("media_sync_incomplete");
}

function syncQueue() {
  if (workerActiveSync) return workerActiveSync;
  const promise = performSyncQueue();
  const settled = promise.finally(() => {
    if (workerActiveSync === settled) workerActiveSync = null;
  });
  workerActiveSync = settled;
  return settled;
}

self.addEventListener("sync", (event) => {
  if (event.tag === "stonegate-media-sync") {
    event.waitUntil(syncQueue());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "stonegate-sync-media") {
    event.waitUntil(syncQueue());
  }
});
