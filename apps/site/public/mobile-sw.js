const SHELL_CACHE = "stonegate-mobile-shell-v12";
const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 3;
// Version 3 keeps queued media binary-safe across WebKit and Chromium.
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const UPLOAD_ROW_LEASE_MS = 10 * 60 * 1000;
const API_FETCH_TIMEOUT_MS = 45 * 1000;
const OBJECT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const QUEUED_BLOB_READ_TIMEOUT_MS = 30 * 1000;
const QUEUED_MEDIA_DIGEST_TIMEOUT_MS = 15 * 1000;
const QUEUED_MEDIA_MIGRATION_TIMEOUT_MS = 5 * 1000;
const QUEUE_UPLOAD_CONCURRENCY = 2;
const QUEUE_HEALTH_TIMEOUT_MS = 30 * 1000;
const DEVICE_ID_KEY = "mobileDeviceId";
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/favicon.png",
];
let workerActiveSync = null;

function workerIsAbortError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function workerPromiseWithTimeout(promise, timeoutMs, errorCode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(errorCode));
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(errorCode));
      },
    );
  });
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

function requestResult(request, onSuccess) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      try {
        resolve(onSuccess ? onSuccess(request.result) : request.result);
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The transaction may already be aborting.
        }
        reject(error);
      }
    };
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
  const keys = await requestResult(
    transaction.objectStore(QUEUE_STORE).getAllKeys(),
  );
  await completion;
  database.close();

  const rows = await Promise.all(
    keys
      .filter((key) => typeof key === "string")
      .map(async (clientId) => {
        const rowDatabase = await openDatabase();
        const rowTransaction = rowDatabase.transaction(QUEUE_STORE, "readonly");
        const rowCompletion = transactionDone(rowTransaction);
        const row = await requestResult(
          // Primary-key reads retain the explicit file path for WebKit's
          // file-backed IndexedDB Blobs.
          rowTransaction.objectStore(QUEUE_STORE).get(clientId),
        );
        await rowCompletion;
        rowDatabase.close();
        return row;
      }),
  );
  return rows.filter(Boolean);
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
  const deviceId = await requestResult(store.get(DEVICE_ID_KEY), (existing) => {
    const resolvedDeviceId =
      typeof existing?.value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        existing.value,
      )
        ? existing.value
        : crypto.randomUUID();
    if (resolvedDeviceId !== existing?.value) {
      store.put({
        key: DEVICE_ID_KEY,
        value: resolvedDeviceId,
        updatedAt: Date.now(),
      });
    }
    return resolvedDeviceId;
  });
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

async function deleteQueuedMedia(clientIds) {
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
}

async function migrateLegacyQueuedMediaBytes(row, validatedBytes) {
  if (row.bytes instanceof ArrayBuffer || !row.blob) return false;

  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  const completion = transactionDone(transaction);
  const store = transaction.objectStore(QUEUE_STORE);
  const abortTimer = setTimeout(() => {
    try {
      transaction.abort();
    } catch {
      // The migration may already have committed.
    }
  }, QUEUED_MEDIA_MIGRATION_TIMEOUT_MS);
  try {
    const migrated = await requestResult(store.get(row.clientId), (current) => {
      if (
        !current ||
        current.bytes instanceof ArrayBuffer ||
        !current.blob ||
        current.employeeId !== row.employeeId ||
        current.appointmentId !== row.appointmentId ||
        current.byteCount !== validatedBytes.byteLength ||
        current.byteCount !== row.byteCount ||
        String(current.checksumSha256).toLowerCase() !==
          String(row.checksumSha256).toLowerCase()
      ) {
        return false;
      }

      const migratedRow = {
        ...current,
        bytes: validatedBytes.slice(0),
      };
      delete migratedRow.blob;
      store.put(migratedRow);
      return true;
    });
    await completion;
    return migrated;
  } finally {
    clearTimeout(abortTimer);
    database.close();
  }
}

function isInterruptedQueueRow(row, now = Date.now()) {
  return (
    (row.status === "uploading" || row.status === "finalizing") &&
    row.updatedAt <= now - UPLOAD_ROW_LEASE_MS
  );
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

function isReadyCompletion(payload, mediaId) {
  return (
    payload?.ok === true &&
    payload?.media?.id === mediaId &&
    payload.media.status === "ready"
  );
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

function workerBytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function materializeQueuedUploadBody(row) {
  if (
    (!row.bytes && !row.blob) ||
    !Number.isSafeInteger(row.byteCount) ||
    row.byteCount <= 0
  ) {
    throw new WorkerQueueUploadError("queued_media_blob_invalid", "retry");
  }

  const readers = [];
  const storedBytes = row.bytes;
  if (storedBytes instanceof ArrayBuffer) {
    readers.push(() => Promise.resolve(storedBytes.slice(0)));
  }
  const legacyBlob = row.blob;
  if (legacyBlob && typeof legacyBlob.arrayBuffer === "function") {
    readers.push(() => legacyBlob.arrayBuffer());
  }
  if (legacyBlob && typeof Response !== "undefined") {
    readers.push(() => new Response(legacyBlob).arrayBuffer());
  }
  if (legacyBlob && typeof legacyBlob.stream === "function") {
    readers.push(async () => {
      const reader = legacyBlob.stream().getReader();
      const output = new Uint8Array(row.byteCount);
      let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (
            !(value instanceof Uint8Array) ||
            offset + value.byteLength > row.byteCount
          ) {
            throw new Error("queued_media_blob_size_mismatch");
          }
          output.set(value, offset);
          offset += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      return output.buffer.slice(0, offset);
    });
  }

  let sawSizeMismatch = false;
  const bytes = await new Promise((resolve, reject) => {
    let pendingReaders = readers.length;
    let resolved = false;
    const rejectIfExhausted = () => {
      pendingReaders -= 1;
      if (!resolved && pendingReaders === 0) {
        reject(
          new WorkerQueueUploadError(
            sawSizeMismatch
              ? "queued_media_blob_size_mismatch"
              : "queued_media_blob_read_failed",
            "retry",
          ),
        );
      }
    };

    if (!pendingReaders) {
      reject(
        new WorkerQueueUploadError("queued_media_blob_read_failed", "retry"),
      );
      return;
    }
    for (const read of readers) {
      void workerPromiseWithTimeout(
        Promise.resolve().then(read),
        QUEUED_BLOB_READ_TIMEOUT_MS,
        "queued_media_blob_read_timeout",
      )
        .then(async (candidateBytes) => {
          if (candidateBytes.byteLength !== row.byteCount) {
            sawSizeMismatch = true;
            throw new Error("queued_media_blob_size_mismatch");
          }
          const digest = await workerPromiseWithTimeout(
            crypto.subtle.digest("SHA-256", candidateBytes),
            QUEUED_MEDIA_DIGEST_TIMEOUT_MS,
            "queued_media_digest_failed",
          );
          if (
            workerBytesToHex(new Uint8Array(digest)) !==
            String(row.checksumSha256).toLowerCase()
          ) {
            throw new Error("queued_media_checksum_mismatch");
          }
          return candidateBytes;
        })
        .then((candidateBytes) => {
          if (resolved) return;
          resolved = true;
          resolve(candidateBytes);
        }, rejectIfExhausted);
    }
  });

  if (!(storedBytes instanceof ArrayBuffer) && legacyBlob) {
    // Only validated legacy Blob rows are rewritten. Normal progress and
    // retry state never rewrites the large binary queue record.
    await workerPromiseWithTimeout(
      migrateLegacyQueuedMediaBytes(row, bytes),
      QUEUED_MEDIA_MIGRATION_TIMEOUT_MS,
      "queued_media_migration_timeout",
    ).catch(() => undefined);
  }
  return bytes;
}

async function uploadRow(row) {
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
      // WebKit can acknowledge a fetch that streams an IndexedDB-backed Blob
      // while sending a zero-byte body. Materializing it gives fetch a concrete
      // length and preserves the queue when the stored bytes are incomplete.
      const uploadBody = await materializeQueuedUploadBody(row);
      const objectResponse = await workerFetchWithTimeout(
        intent.uploadUrl,
        {
          method: "PUT",
          headers: {
            "content-type": row.contentType,
            ...intent.uploadHeaders,
          },
          body: uploadBody,
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
    if (!isReadyCompletion(completePayload, intent.mediaId)) {
      throw new WorkerQueueUploadError(
        "invalid_media_finalize_response",
        "retry",
      );
    }
    return "success";
  } catch (error) {
    return workerUploadFailureMode(error);
  }
}

async function performSyncQueue() {
  const openWindows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (openWindows.length) return;

  const activeEmployeeId = await getActiveEmployeeId();
  if (!activeEmployeeId) return;
  const rows = (await getQueue()).filter(
    (row) =>
      row.employeeId === activeEmployeeId &&
      (row.status === "queued" || isInterruptedQueueRow(row)),
  );
  if (!rows.length) return;

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

  let nextRowIndex = 0;
  let retryableFailures = 0;
  let authPaused = false;
  try {
    const uploadWorker = async () => {
      while (!authPaused) {
        const row = rows[nextRowIndex];
        nextRowIndex += 1;
        if (!row) return;

        const outcome = await uploadRow(row);
        if (outcome === "success") {
          try {
            await deleteQueuedMedia([row.clientId]);
          } catch {
            retryableFailures += 1;
          }
        } else if (outcome === "retry") {
          retryableFailures += 1;
        } else if (outcome === "auth_paused") {
          authPaused = true;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(QUEUE_UPLOAD_CONCURRENCY, rows.length) },
        () => uploadWorker(),
      ),
    );
  } finally {
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
