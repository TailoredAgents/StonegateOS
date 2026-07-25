"use client";

import * as React from "react";
import {
  MOBILE_MEDIA_QUEUE_EVENT,
  MOBILE_STORAGE_WARNING_EVENT,
  cacheAppointmentMedia,
  checkStoragePressure,
  getQueueSummary,
  registerMediaBackgroundSync,
  reportOfflineQueueHealth,
  requestPersistentStorage,
  saveAppointmentSnapshots,
  syncQueuedMedia,
  type OfflineAppointmentSnapshot,
  type PersistentStorageState,
  type QueueSummary,
} from "./lib/offline-media";

type SnapshotInput = Omit<
  OfflineAppointmentSnapshot,
  "key" | "employeeId" | "savedAt" | "expiresAt"
>;

function mediaItems(payload: unknown): Array<{
  id: string;
  caption?: string | null;
  source?: string | null;
  isCover?: boolean;
  sortOrder?: number;
  displayUrl?: string | null;
  contentType?: string | null;
}> | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)["items"];
  if (!Array.isArray(value)) return null;
  return Array.isArray(value)
    ? value.filter(
        (
          item,
        ): item is {
          id: string;
          caption?: string | null;
          source?: string | null;
          isCover?: boolean;
          sortOrder?: number;
          displayUrl?: string | null;
          contentType?: string | null;
        } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>)["id"] === "string",
      )
    : [];
}

export function MobileOfflineRuntime({
  employeeId,
  dayKey,
  authoritative,
  snapshots,
}: {
  employeeId: string;
  dayKey: string;
  authoritative: boolean;
  snapshots: SnapshotInput[];
}) {
  const [queue, setQueue] = React.useState<QueueSummary | null>(null);
  const [persistentStorage, setPersistentStorage] =
    React.useState<PersistentStorageState | null>(null);
  const [storagePressure, setStoragePressure] = React.useState<number | null>(
    null,
  );

  const refreshQueue = React.useCallback(async () => {
    const summary = await getQueueSummary(employeeId).catch(() => null);
    setQueue(summary);
    if (summary?.total) await registerMediaBackgroundSync();
    void reportOfflineQueueHealth(employeeId);
  }, [employeeId]);

  const synchronize = React.useCallback(async () => {
    if (!navigator.onLine) return;
    await syncQueuedMedia(employeeId).catch(() => undefined);
    await refreshQueue();
  }, [employeeId, refreshQueue]);

  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/mobile-sw.js", {
      scope: "/mobile",
    });
  }, []);

  React.useEffect(() => {
    void saveAppointmentSnapshots(employeeId, dayKey, snapshots, {
      authoritative,
    });
    void requestPersistentStorage().then(setPersistentStorage);
    void checkStoragePressure().then(setStoragePressure);

    const prefetch = async () => {
      const workers = snapshots.map(async (snapshot) => {
        try {
          const response = await fetch(
            `/api/mobile/appointments/${encodeURIComponent(snapshot.appointmentId)}/media`,
            { cache: "no-store" },
          );
          if (!response.ok) return;
          const payload = (await response.json().catch(() => null)) as unknown;
          const parsedItems = mediaItems(payload);
          if (!parsedItems) return;
          const items = parsedItems.map((item) => ({
            ...item,
            orderIndex: item.sortOrder ?? 0,
          }));
          await cacheAppointmentMedia(
            employeeId,
            snapshot.appointmentId,
            items,
          );
        } catch {
          // A partial cache is still useful; retry on the next foreground.
        }
      });
      await Promise.allSettled(workers);
    };
    void prefetch();
  }, [authoritative, dayKey, employeeId, snapshots]);

  React.useEffect(() => {
    void refreshQueue();
    void synchronize();

    const onOnline = () => void synchronize();
    const onQueueChange = () => void refreshQueue();
    const onStorageWarning = (event: Event) => {
      const detail = (event as CustomEvent<{ ratio?: number }>).detail;
      if (typeof detail?.ratio === "number") setStoragePressure(detail.ratio);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void synchronize();
        void checkStoragePressure().then(setStoragePressure);
      }
    };
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as Record<string, unknown>)["type"] ===
          "stonegate-media-sync-complete"
      ) {
        void refreshQueue();
        void checkStoragePressure().then(setStoragePressure);
      }
    };
    const retryTimer = window.setInterval(() => {
      void refreshQueue();
      if (document.visibilityState === "visible" && navigator.onLine) {
        void synchronize();
      }
    }, 60_000);

    window.addEventListener("online", onOnline);
    window.addEventListener(MOBILE_MEDIA_QUEUE_EVENT, onQueueChange);
    window.addEventListener(MOBILE_STORAGE_WARNING_EVENT, onStorageWarning);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(MOBILE_MEDIA_QUEUE_EVENT, onQueueChange);
      window.removeEventListener(
        MOBILE_STORAGE_WARNING_EVENT,
        onStorageWarning,
      );
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      window.clearInterval(retryTimer);
    };
  }, [refreshQueue, synchronize]);

  const persistenceWarning =
    persistentStorage !== null && persistentStorage !== "granted";

  if (
    !queue?.total &&
    !persistenceWarning &&
    (storagePressure === null || storagePressure < 0.8)
  ) {
    return null;
  }

  return (
    <div className="space-y-2" aria-live="polite">
      {queue?.total ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            queue.failed || queue.stale
              ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
              : "border-cyan-300/30 bg-cyan-300/10 text-cyan-100"
          }`}
        >
          <p className="font-semibold">
            {queue.total} photo{queue.total === 1 ? "" : "s"} waiting to upload
          </p>
          <p className="mt-1 text-xs leading-5">
            {queue.uploading ? `${queue.uploading} uploading now. ` : ""}
            {queue.failed ? `${queue.failed} need retry. ` : ""}
            {queue.stale
              ? `${queue.stale} have been waiting more than 24 hours.`
              : "They stay safely on this phone until upload succeeds."}
          </p>
        </div>
      ) : null}
      {storagePressure !== null && storagePressure >= 0.8 ? (
        <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          Phone storage is nearly full. Keep StonegateOS open with a connection
          so queued photos can finish uploading.
        </div>
      ) : null}
      {persistenceWarning ? (
        <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          This phone cannot guarantee protected offline storage. Keep
          StonegateOS open until queued photos finish uploading, and avoid
          clearing browser data.
        </div>
      ) : null}
    </div>
  );
}
