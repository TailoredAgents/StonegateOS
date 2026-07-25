const SHELL_CACHE = "stonegate-mobile-shell-v2";
const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 2;
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const UPLOAD_ROW_LEASE_MS = 10 * 60 * 1000;
const SYNC_COORDINATOR_LEASE_MS = 10 * 60 * 1000;
const SYNC_COORDINATOR_HEARTBEAT_MS = 60 * 1000;
const SYNC_LEASE_KEY = "mediaSyncLease";
const DEVICE_ID_KEY = "mobileDeviceId";
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/favicon.png",
];

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
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("db_transaction_failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("db_transaction_aborted"));
  });
}

async function getQueue() {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readonly");
  const rows = await requestResult(
    transaction.objectStore(QUEUE_STORE).getAll(),
  );
  await transactionDone(transaction);
  database.close();
  return rows;
}

async function getActiveEmployeeId() {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readonly");
  const row = await requestResult(
    transaction.objectStore(METADATA_STORE).get("activeEmployeeId"),
  );
  await transactionDone(transaction);
  database.close();
  return typeof row?.value === "string" ? row.value : null;
}

async function getOrCreateDeviceId() {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
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
  await transactionDone(transaction);
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
    await fetch("/api/mobile/offline-media-queue-health", {
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
    });
  } catch {
    // The next foreground/visibility sync reports the queue again.
  }
}

async function acquireSyncLease(owner, employeeId) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  const now = Date.now();
  if (existing && existing.expiresAt > now && existing.owner !== owner) {
    await transactionDone(transaction);
    database.close();
    return false;
  }
  store.put({
    key: SYNC_LEASE_KEY,
    owner,
    employeeId,
    expiresAt: now + SYNC_COORDINATOR_LEASE_MS,
  });
  await transactionDone(transaction);
  database.close();
  return true;
}

async function renewSyncLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  if (existing?.owner === owner) {
    store.put({
      ...existing,
      expiresAt: Date.now() + SYNC_COORDINATOR_LEASE_MS,
    });
  }
  await transactionDone(transaction);
  database.close();
  return existing?.owner === owner;
}

async function releaseSyncLease(owner) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const store = transaction.objectStore(METADATA_STORE);
  const existing = await requestResult(store.get(SYNC_LEASE_KEY));
  if (existing?.owner === owner) store.delete(SYNC_LEASE_KEY);
  await transactionDone(transaction);
  database.close();
}

async function reclaimInterruptedRows(employeeId) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
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
  await transactionDone(transaction);
  database.close();
}

async function putQueue(row) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  transaction.objectStore(QUEUE_STORE).put(row);
  await transactionDone(transaction);
  database.close();
}

async function deleteQueue(clientId) {
  const database = await openDatabase();
  const transaction = database.transaction(QUEUE_STORE, "readwrite");
  transaction.objectStore(QUEUE_STORE).delete(clientId);
  await transactionDone(transaction);
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
  if (!mediaId || (!uploadUrl && candidate.status !== "ready")) return null;
  return {
    mediaId,
    uploadUrl,
    uploadHeaders,
    ready: candidate.status === "ready",
  };
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
    const intentResponse = await fetch(
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
    );
    const intentPayload = await intentResponse.json().catch(() => null);
    if (!intentResponse.ok) {
      throw new Error(
        intentPayload?.message ||
          intentPayload?.error ||
          "upload_intent_failed",
      );
    }
    const intent = firstIntent(intentPayload);
    if (!intent) throw new Error("invalid_upload_intent");

    if (!intent.ready) {
      const objectResponse = await fetch(intent.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": row.contentType,
          ...intent.uploadHeaders,
        },
        body: row.blob,
      });
      if (!objectResponse.ok) throw new Error("object_upload_failed");
    }

    await putQueue({
      ...working,
      status: "finalizing",
      updatedAt: Date.now(),
    });
    const completeResponse = await fetch(
      `/api/mobile/appointment-media/${encodeURIComponent(intent.mediaId)}/complete`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checksumSha256: row.checksumSha256 }),
      },
    );
    const completePayload = await completeResponse.json().catch(() => null);
    if (!completeResponse.ok) {
      throw new Error(
        completePayload?.message ||
          completePayload?.error ||
          "media_finalize_failed",
      );
    }
    await deleteQueue(row.clientId);
    return true;
  } catch (error) {
    await putQueue({
      ...working,
      status: "failed",
      error: error instanceof Error ? error.message : "upload_failed",
      updatedAt: Date.now(),
    });
    return false;
  }
}

async function syncQueue() {
  const activeEmployeeId = await getActiveEmployeeId();
  if (!activeEmployeeId) return;
  const sessionResponse = await fetch("/api/mobile/me", {
    credentials: "include",
    cache: "no-store",
  });
  if (!sessionResponse.ok) return;
  const sessionPayload = await sessionResponse.json().catch(() => null);
  if (sessionPayload?.teamMember?.id !== activeEmployeeId) return;

  const owner = `worker:${crypto.randomUUID()}`;
  if (!(await acquireSyncLease(owner, activeEmployeeId))) return;

  let leaseActive = true;
  const heartbeat = setInterval(() => {
    void renewSyncLease(owner).then((renewed) => {
      leaseActive = renewed;
    });
  }, SYNC_COORDINATOR_HEARTBEAT_MS);
  let failed = 0;
  try {
    await reclaimInterruptedRows(activeEmployeeId);
    const rows = (await getQueue()).filter(
      (row) =>
        row.employeeId === activeEmployeeId &&
        (row.status === "queued" || row.status === "failed"),
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length && leaseActive) {
        const row = rows[cursor++];
        if (!row) continue;
        leaseActive = await renewSyncLease(owner);
        if (!leaseActive) return;
        if (!(await uploadRow(row))) failed += 1;
      }
    };
    await Promise.all([worker(), worker()]);
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
  if (failed > 0) throw new Error("media_sync_incomplete");
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
