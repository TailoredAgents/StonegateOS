"use client";

import * as React from "react";
import {
  MOBILE_MEDIA_QUEUE_EVENT,
  MOBILE_STALE_QUEUE_MS,
  MOBILE_STORAGE_WARNING_EVENT,
  checkStoragePressure,
  discardQueuedMedia,
  getAppointmentSnapshots,
  getCachedAppointmentMedia,
  getRememberedMobileEmployee,
  isInterruptedQueueRow,
  listEmployeeQueue,
  queueMediaUpload,
  registerMediaBackgroundSync,
  reportOfflineQueueHealth,
  requestPersistentStorage,
  retryQueuedMedia,
  stonegateDayKey,
  syncQueuedMedia,
  type OfflineAppointmentSnapshot,
  type OfflineMediaRecord,
  type PersistentStorageState,
  type QueuedMediaUpload,
} from "../lib/offline-media";

type OfflineJob = OfflineAppointmentSnapshot & {
  media: Array<OfflineMediaRecord & { objectUrl: string }>;
  queue: QueuedMediaUpload[];
};

function OfflineQueueList({
  employeeId,
  items,
}: {
  employeeId: string;
  items: QueuedMediaUpload[];
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const interrupted = isInterruptedQueueRow(item);
        const retryable = item.status === "failed" || interrupted;
        const discardable = retryable || item.status === "queued";
        return (
          <div
            key={item.clientId}
            className="rounded-md border border-white/10 bg-slate-950 p-3 text-sm"
          >
            <p className="truncate font-semibold">{item.filename}</p>
            <p className="mt-1 text-xs capitalize text-slate-400">
              {interrupted ? "Upload interrupted" : item.status}
              {item.error ? ` · ${item.error}` : ""}
            </p>
            {retryable || discardable ? (
              <div
                className={`mt-2 grid gap-2 ${
                  retryable && discardable ? "grid-cols-2" : "grid-cols-1"
                }`}
              >
                {retryable ? (
                  <button
                    type="button"
                    onClick={() => {
                      void retryQueuedMedia(item.clientId).then(() =>
                        syncQueuedMedia(employeeId),
                      );
                    }}
                    className="rounded-md border border-cyan-300/40 px-2 py-2 text-xs font-semibold text-cyan-100"
                  >
                    Retry
                  </button>
                ) : null}
                {discardable ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Discard this unsynced photo from this phone?",
                        )
                      ) {
                        void discardQueuedMedia(item.clientId);
                      }
                    }}
                    className="rounded-md border border-rose-300/30 px-2 py-2 text-xs font-semibold text-rose-100"
                  >
                    Discard
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function friendlyUploadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "upload_failed";
  if (message === "image_too_large") return "That photo is larger than 10 MB.";
  if (message === "unsupported_image") {
    return "Use a JPEG, PNG, WebP, HEIC, or HEIF image.";
  }
  if (message === "image_decode_failed") {
    return "This phone could not prepare that image while offline.";
  }
  if (message === "unsafe_image_dimensions") {
    return "That image is too large to process safely.";
  }
  return "Unable to save that photo on this phone.";
}

export default function MobileOfflinePage() {
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<OfflineJob[]>([]);
  const [queue, setQueue] = React.useState<QueuedMediaUpload[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [captions, setCaptions] = React.useState<Record<string, string>>({});
  const [now, setNow] = React.useState(() => Date.now());
  const [persistentStorage, setPersistentStorage] =
    React.useState<PersistentStorageState | null>(null);
  const [storagePressure, setStoragePressure] = React.useState<number | null>(
    null,
  );

  const load = React.useCallback(async (resolvedEmployeeId: string) => {
    const [snapshots, queuedItems] = await Promise.all([
      getAppointmentSnapshots(resolvedEmployeeId, stonegateDayKey()),
      listEmployeeQueue(resolvedEmployeeId),
    ]);
    const hydrated = await Promise.all(
      snapshots.map(async (snapshot): Promise<OfflineJob> => {
        const media = await getCachedAppointmentMedia(
          resolvedEmployeeId,
          snapshot.appointmentId,
        );
        return {
          ...snapshot,
          media: media.map((item) => ({
            ...item,
            objectUrl: URL.createObjectURL(item.blob),
          })),
          queue: queuedItems.filter(
            (item) => item.appointmentId === snapshot.appointmentId,
          ),
        };
      }),
    );
    setQueue(queuedItems);
    if (queuedItems.length) void registerMediaBackgroundSync();
    void reportOfflineQueueHealth(resolvedEmployeeId);
    setJobs((current) => {
      for (const job of current) {
        for (const item of job.media) URL.revokeObjectURL(item.objectUrl);
      }
      return hydrated;
    });
  }, []);

  React.useEffect(() => {
    const remembered = getRememberedMobileEmployee();
    setEmployeeId(remembered);
    if (!remembered) {
      setLoading(false);
      return;
    }
    void load(remembered)
      .catch(() => setError("Offline jobs could not be opened on this phone."))
      .finally(() => setLoading(false));
  }, [load]);

  React.useEffect(() => {
    if (!employeeId) return;
    const refresh = () => {
      void load(employeeId);
      void syncQueuedMedia(employeeId).catch(() => undefined);
    };
    window.addEventListener(MOBILE_MEDIA_QUEUE_EVENT, refresh);
    return () => window.removeEventListener(MOBILE_MEDIA_QUEUE_EVENT, refresh);
  }, [employeeId, load]);

  React.useEffect(() => {
    void requestPersistentStorage().then(setPersistentStorage);
    void checkStoragePressure().then(setStoragePressure);

    const onStorageWarning = (event: Event) => {
      const detail = (event as CustomEvent<{ ratio?: number }>).detail;
      if (typeof detail?.ratio === "number") setStoragePressure(detail.ratio);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void checkStoragePressure().then(setStoragePressure);
      }
    };
    window.addEventListener(MOBILE_STORAGE_WARNING_EVENT, onStorageWarning);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener(
        MOBILE_STORAGE_WARNING_EVENT,
        onStorageWarning,
      );
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (!employeeId) return;
    const synchronize = async () => {
      await syncQueuedMedia(employeeId).catch(() => undefined);
      await load(employeeId).catch(() => undefined);
    };
    const onOnline = () => void synchronize();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void synchronize();
    };
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as Record<string, unknown>)["type"] ===
          "stonegate-media-sync-complete"
      ) {
        void load(employeeId);
        void checkStoragePressure().then(setStoragePressure);
      }
    };
    const retryTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void synchronize();
      }
    }, 15_000);
    void synchronize();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      window.clearInterval(retryTimer);
    };
  }, [employeeId, load]);

  React.useEffect(
    () => () => {
      for (const job of jobs) {
        for (const item of job.media) URL.revokeObjectURL(item.objectUrl);
      }
    },
    [jobs],
  );

  const chooseFiles = async (
    appointmentId: string,
    files: FileList | null,
    input: HTMLInputElement,
  ) => {
    try {
      if (!employeeId || !files?.length) return;
      setError(null);
      const selected = Array.from(files).slice(0, 10);
      for (const file of selected) {
        try {
          await queueMediaUpload({
            employeeId,
            appointmentId,
            file,
            capturedOffline: true,
            caption: captions[appointmentId] ?? null,
          });
        } catch (uploadError) {
          setError(friendlyUploadError(uploadError));
        }
      }
      await load(employeeId);
    } finally {
      input.value = "";
    }
  };

  const appointmentIds = new Set(jobs.map((job) => job.appointmentId));
  const unlinkedQueue = queue.filter(
    (item) => !appointmentIds.has(item.appointmentId),
  );
  const staleQueueCount = queue.filter(
    (item) => item.createdAt <= now - MOBILE_STALE_QUEUE_MS,
  ).length;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white">
      <div className="mx-auto max-w-xl space-y-4">
        <header className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
            Offline Today
          </p>
          <h1 className="mt-1 text-xl font-semibold">StonegateOS</h1>
          <p className="mt-2 text-sm leading-6 text-amber-100">
            Cached job details and photos remain available. New photos stay on
            this phone and upload when StonegateOS is reopened with a
            connection. Payments are disabled offline.
          </p>
        </header>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-3 text-sm text-rose-100"
          >
            {error}
          </div>
        ) : null}

        {persistentStorage !== null && persistentStorage !== "granted" ? (
          <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">
            This phone cannot guarantee protected offline storage. Avoid
            clearing browser data, and keep StonegateOS open when a connection
            returns until every photo uploads.
          </div>
        ) : null}

        {storagePressure !== null && storagePressure >= 0.8 ? (
          <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">
            Phone storage is nearly full. Connect now and keep StonegateOS open
            so queued photos can finish uploading.
          </div>
        ) : null}

        {staleQueueCount ? (
          <div className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-3 text-sm leading-6 text-rose-100">
            {staleQueueCount} unsynced photo
            {staleQueueCount === 1 ? " has" : "s have"} been waiting more than
            24 hours. Reconnect and retry below; do not clear this browser’s
            data.
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-lg border border-white/10 bg-slate-900 p-4 text-sm text-slate-300">
            Opening cached jobs…
          </div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
            No current jobs have been cached for this employee. Reopen
            StonegateOS while online before the workday starts.
          </div>
        ) : (
          jobs.map((job) => (
            <details
              key={job.appointmentId}
              className="overflow-hidden rounded-lg border border-white/10 bg-slate-900"
            >
              <summary className="cursor-pointer list-none p-4">
                <p className="text-sm font-semibold text-cyan-100">
                  {formatTime(job.start)} – {formatTime(job.end)}
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  {job.contactName}
                </h2>
                {job.address ? (
                  <p className="mt-1 text-sm text-slate-300">{job.address}</p>
                ) : null}
              </summary>
              <div className="space-y-4 border-t border-white/10 p-4">
                <section>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                    Quoted to remove
                  </p>
                  <p
                    className={`mt-2 whitespace-pre-wrap rounded-md border p-3 text-sm leading-6 ${
                      job.quotedScopeText
                        ? "border-white/10 bg-slate-950 text-slate-200"
                        : "border-amber-300/30 bg-amber-300/10 text-amber-100"
                    }`}
                  >
                    {job.quotedScopeText ||
                      "Scope is missing. Payment and completion remain blocked until staff fills it in online."}
                  </p>
                </section>

                {job.media.length ? (
                  <div className="grid grid-cols-2 gap-2">
                    {job.media.map((item) => (
                      <figure
                        key={item.mediaId}
                        className="overflow-hidden rounded-md border border-white/10 bg-slate-950"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.objectUrl}
                          alt={item.caption || "Quoted work"}
                          className="aspect-square w-full object-cover"
                        />
                        <figcaption className="p-2 text-xs text-slate-300">
                          {item.caption || "Quoted work"}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-white/10 p-3 text-sm text-slate-400">
                    No quoted-work images were cached.
                  </p>
                )}

                {job.canCaptureMedia ? (
                  <>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">
                        Caption for new photos (optional)
                      </span>
                      <input
                        value={captions[job.appointmentId] ?? ""}
                        onChange={(event) =>
                          setCaptions((current) => ({
                            ...current,
                            [job.appointmentId]: event.target.value,
                          }))
                        }
                        maxLength={500}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white"
                        placeholder="Left side of garage"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="cursor-pointer rounded-md bg-cyan-300 px-3 py-3 text-center text-sm font-semibold text-slate-950">
                        Take photos
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                          capture="environment"
                          className="sr-only"
                          onChange={(event) => {
                            const input = event.currentTarget;
                            void chooseFiles(
                              job.appointmentId,
                              input.files,
                              input,
                            );
                          }}
                        />
                      </label>
                      <label className="cursor-pointer rounded-md border border-cyan-300/40 bg-slate-950 px-3 py-3 text-center text-sm font-semibold text-cyan-100">
                        Choose photos
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                          multiple
                          className="sr-only"
                          onChange={(event) => {
                            const input = event.currentTarget;
                            void chooseFiles(
                              job.appointmentId,
                              input.files,
                              input,
                            );
                          }}
                        />
                      </label>
                    </div>
                  </>
                ) : null}

                {job.queue.length ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">
                      Waiting on this phone
                    </p>
                    <OfflineQueueList
                      employeeId={employeeId ?? job.employeeId}
                      items={job.queue}
                    />
                  </div>
                ) : null}

                {job.paymentSummary ? (
                  <button
                    type="button"
                    disabled
                    className="w-full cursor-not-allowed rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-sm font-semibold text-slate-500"
                  >
                    Accept payment · Online only
                  </button>
                ) : null}
              </div>
            </details>
          ))
        )}

        {!loading && employeeId && unlinkedQueue.length ? (
          <section className="rounded-lg border border-amber-300/30 bg-slate-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">
              Unsynced photos from older jobs
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Their cached job cards expired, but the original photos remain
              safely on this phone until they upload or you explicitly discard
              them.
            </p>
            <div className="mt-3">
              <OfflineQueueList employeeId={employeeId} items={unlinkedQueue} />
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
