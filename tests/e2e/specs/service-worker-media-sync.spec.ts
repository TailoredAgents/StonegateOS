import { expect, test } from "../test";

type WorkerSyncResult = {
  arrayBufferCalls: number;
  completedUploads: number;
  openWindowCount: number;
  queueLength: number;
  uploadByteCount: number;
};

test.use({
  storageState: "tests/e2e/storage/mobile-owner.json",
  serviceWorkers: "allow",
});

test("service worker recovers a legacy Blob queue row with no open window", async ({
  context,
  page,
}) => {
  const appointmentId = "11111111-1111-4111-8111-111111111111";
  const clientId = "22222222-2222-4222-8222-222222222222";
  const employeeId = "33333333-3333-4333-8333-333333333333";
  const mediaId = "44444444-4444-4444-8444-444444444444";
  const imageBytes = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];

  await page.goto("/mobile/offline");

  const workerCreated = context.waitForEvent("serviceworker");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      "/mobile-sw.js",
      {
        scope: "/mobile",
      },
    );
    const activeWorker =
      registration.active || registration.waiting || registration.installing;
    if (!activeWorker) throw new Error("The mobile worker did not register.");
    if (activeWorker.state !== "activated") {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("The mobile worker did not activate.")),
          15_000,
        );
        activeWorker.addEventListener("statechange", () => {
          if (activeWorker.state !== "activated") return;
          window.clearTimeout(timeout);
          resolve();
        });
      });
    }
  });
  const worker = await workerCreated;

  await page.evaluate(
    async ({
      appointmentId: queuedAppointmentId,
      clientId: queuedClientId,
      employeeId: queuedEmployeeId,
      imageBytes: queuedImageBytes,
    }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("stonegate-mobile", 3);
        request.onupgradeneeded = () => {
          const upgradedDatabase = request.result;
          if (
            !upgradedDatabase.objectStoreNames.contains("appointment-snapshots")
          ) {
            upgradedDatabase.createObjectStore("appointment-snapshots", {
              keyPath: "key",
            });
          }
          if (
            !upgradedDatabase.objectStoreNames.contains("appointment-media")
          ) {
            upgradedDatabase.createObjectStore("appointment-media", {
              keyPath: "key",
            });
          }
          if (
            !upgradedDatabase.objectStoreNames.contains("media-upload-queue")
          ) {
            upgradedDatabase.createObjectStore("media-upload-queue", {
              keyPath: "clientId",
            });
          }
          if (!upgradedDatabase.objectStoreNames.contains("app-metadata")) {
            upgradedDatabase.createObjectStore("app-metadata", {
              keyPath: "key",
            });
          }
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Unable to open the media DB."));
        request.onsuccess = () => resolve(request.result);
      });
      const bytes = new Uint8Array(queuedImageBytes);
      const checksumSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const transaction = database.transaction(
        ["app-metadata", "media-upload-queue"],
        "readwrite",
      );
      const complete = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("The queue transaction failed."),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("The queue transaction aborted."),
          );
      });
      transaction.objectStore("app-metadata").put({
        key: "activeEmployeeId",
        value: queuedEmployeeId,
        updatedAt: Date.now(),
      });
      transaction.objectStore("media-upload-queue").put({
        clientId: queuedClientId,
        employeeId: queuedEmployeeId,
        appointmentId: queuedAppointmentId,
        filename: "legacy.png",
        contentType: "image/png",
        byteCount: bytes.byteLength,
        checksumSha256,
        caption: null,
        quotedScopeText: "Remove the photographed item.",
        blob: new Blob([bytes], { type: "image/png" }),
        capturedOffline: true,
        status: "queued",
        error: null,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await complete;
      database.close();
    },
    { appointmentId, clientId, employeeId, imageBytes },
  );

  await worker.evaluate(
    ({ activeEmployeeId, completedMediaId, expectedUploadPath }) => {
      const workerScope = globalThis as typeof globalThis & {
        __stonegateWorkerSyncTest?: {
          arrayBufferCalls: number;
          completedUploads: number;
          uploadByteCount: number;
        };
      };
      workerScope.__stonegateWorkerSyncTest = {
        arrayBufferCalls: 0,
        completedUploads: 0,
        uploadByteCount: 0,
      };

      const nativeSetTimeout = workerScope.setTimeout.bind(workerScope);
      workerScope.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) =>
        nativeSetTimeout(
          handler,
          timeout === 30_000 ? 25 : timeout,
          ...args,
        )) as typeof setTimeout;

      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        value() {
          workerScope.__stonegateWorkerSyncTest!.arrayBufferCalls += 1;
          return new Promise<ArrayBuffer>(() => undefined);
        },
      });

      workerScope.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input.url;
        const url = new URL(rawUrl, workerScope.location.origin);
        if (url.pathname === "/api/mobile/me") {
          return Response.json({
            teamMember: { id: activeEmployeeId },
          });
        }
        if (url.pathname.endsWith("/media/upload-intents")) {
          return Response.json({
            intents: [
              {
                mediaId: completedMediaId,
                uploadUrl: `${workerScope.location.origin}${expectedUploadPath}`,
                headers: {},
                alreadyCompleted: false,
              },
            ],
          });
        }
        if (url.pathname === expectedUploadPath) {
          const body = init?.body;
          workerScope.__stonegateWorkerSyncTest!.uploadByteCount =
            body instanceof ArrayBuffer
              ? body.byteLength
              : ArrayBuffer.isView(body)
                ? body.byteLength
                : 0;
          return new Response(null, { status: 200 });
        }
        if (
          url.pathname ===
          `/api/mobile/appointment-media/${completedMediaId}/complete`
        ) {
          workerScope.__stonegateWorkerSyncTest!.completedUploads += 1;
          return Response.json({
            ok: true,
            media: { id: completedMediaId, status: "ready" },
          });
        }
        if (url.pathname === "/api/mobile/offline-media-queue-health") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected worker request: ${url.pathname}`);
      }) as typeof fetch;
    },
    {
      activeEmployeeId: employeeId,
      completedMediaId: mediaId,
      expectedUploadPath: "/__e2e/service-worker-media-object",
    },
  );

  // Begin the worker task before closing the page so Chromium cannot retire the
  // otherwise-idle service worker between the last client closing and evaluate.
  // The production sync itself still starts only after the worker observes that
  // it has no window clients.
  const syncResult = worker.evaluate(`(async () => {
    let openWindows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (let attempt = 0; openWindows.length && attempt < 500; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      openWindows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
    }
    if (openWindows.length) throw new Error("window_client_still_open");
    await syncQueue();
    const rows = await getQueue();
    return {
      ...self.__stonegateWorkerSyncTest,
      openWindowCount: openWindows.length,
      queueLength: rows.length,
    };
  })()`);

  await page.close();
  await expect.poll(() => context.pages().length).toBe(0);
  const result = (await syncResult) as WorkerSyncResult;

  expect(result).toEqual({
    arrayBufferCalls: 1,
    completedUploads: 1,
    openWindowCount: 0,
    queueLength: 0,
    uploadByteCount: imageBytes.length,
  });
});
