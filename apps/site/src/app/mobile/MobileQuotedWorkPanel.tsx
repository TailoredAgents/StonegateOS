"use client";

import * as React from "react";
import {
  MOBILE_MEDIA_QUEUE_EVENT,
  cacheAppointmentMedia,
  discardQueuedMedia,
  getAppointmentQueue,
  getCachedAppointmentMedia,
  isInterruptedQueueRow,
  queueMediaUpload,
  retryQueuedMedia,
  syncQueuedMedia,
  type QueuedMediaUpload,
} from "./lib/offline-media";

export type AppointmentMediaSummary = {
  readyCount: number;
  pendingCount: number;
  coverMediaId: string | null;
  needsScope: boolean;
};

type MediaItem = {
  id: string;
  status: string;
  caption: string | null;
  sortOrder: number;
  isCover: boolean;
  source: string | null;
  filename: string | null;
  contentType: string | null;
  thumbnailUrl: string | null;
  displayUrl: string | null;
  originalUrl: string | null;
  error?: string | null;
};

type MediaResponse = {
  quotedScopeText?: string | null;
  mediaSummary?: AppointmentMediaSummary;
  items?: MediaItem[];
  legacyAttachments?: Array<{
    id: string;
    filename: string | null;
    contentType: string | null;
    url: string;
  }>;
};

type DeletedMediaItem = {
  id: string;
  caption: string | null;
  filename: string | null;
  source: string | null;
  deletedAt: string;
};

type MediaReassignmentOption = {
  appointmentId: string;
  startAt: string | null;
  status: string;
  type: string;
};

type MediaManageResponse = {
  deletedItems?: DeletedMediaItem[];
  reassignmentOptions?: MediaReassignmentOption[];
};

function sourceLabel(value: string | null): string {
  if (!value) return "Stonegate";
  const labels: Record<string, string> = {
    direct_upload: "Staff photo",
    offline_mobile: "Staff photo",
    twilio_mms: "Customer MMS",
    facebook_messenger: "Messenger",
    instant_quote: "Instant quote",
    professional_quote: "Professional quote",
    legacy_attachment: "Legacy file",
  };
  return (
    labels[value] ??
    value
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function destinationLabel(option: MediaReassignmentOption): string {
  const startAt = option.startAt ? new Date(option.startAt) : null;
  const scheduled =
    !startAt || Number.isNaN(startAt.getTime())
      ? "Unscheduled"
      : startAt.toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  const type = option.type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${scheduled} · ${type} · ${option.status}`;
}

function friendlyError(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  if (message.includes("image_too_large"))
    return "Each image must be 10 MB or less.";
  if (message.includes("unsupported_image"))
    return "Use JPEG, PNG, WebP, HEIC, or HEIF.";
  if (message.includes("image_decode_failed"))
    return "This phone could not read that image.";
  if (message.includes("unsafe_image_dimensions"))
    return "That image is too large to process safely.";
  if (message.includes("media_writes_disabled"))
    return "Photo uploads are not enabled yet.";
  if (message.includes("offline_media_disabled"))
    return "Offline photo capture is not enabled yet.";
  return "The photo could not be prepared. It was not removed from your library.";
}

async function readError(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const candidate = payload?.["message"] ?? payload?.["error"];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : fallback;
}

export function MobileQuotedWorkPanel({
  appointmentId,
  employeeId,
  initialScope,
  initialSummary,
  canCapture,
  canManage,
  onScopeRequirementChange,
}: {
  appointmentId: string;
  employeeId: string;
  initialScope: string | null;
  initialSummary: AppointmentMediaSummary;
  canCapture: boolean;
  canManage: boolean;
  onScopeRequirementChange?: (needsScope: boolean) => void;
}) {
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [scope, setScope] = React.useState(initialScope ?? "");
  const [summary, setSummary] = React.useState(initialSummary);
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [legacyFiles, setLegacyFiles] = React.useState<
    NonNullable<MediaResponse["legacyAttachments"]>
  >([]);
  const [queue, setQueue] = React.useState<QueuedMediaUpload[]>([]);
  const [newCaption, setNewCaption] = React.useState("");
  const [captionDrafts, setCaptionDrafts] = React.useState<
    Record<string, string>
  >({});
  const [deletedItems, setDeletedItems] = React.useState<DeletedMediaItem[]>(
    [],
  );
  const [reassignmentOptions, setReassignmentOptions] = React.useState<
    MediaReassignmentOption[]
  >([]);
  const [reassignmentDrafts, setReassignmentDrafts] = React.useState<
    Record<string, string>
  >({});
  const [manageLoaded, setManageLoaded] = React.useState(false);
  const [manageLoading, setManageLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [viewer, setViewer] = React.useState<MediaItem | null>(null);
  const cachedObjectUrls = React.useRef<string[]>([]);

  const refreshQueue = React.useCallback(async () => {
    const rows = await getAppointmentQueue(employeeId, appointmentId).catch(
      () => [],
    );
    setQueue(rows);
  }, [appointmentId, employeeId]);

  const loadManageData = React.useCallback(async () => {
    if (!canManage) return;
    setManageLoading(true);
    try {
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/media/manage-options`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          await readError(response, "Unable to load photo management."),
        );
      }
      const payload = (await response.json()) as MediaManageResponse;
      setDeletedItems(
        Array.isArray(payload.deletedItems) ? payload.deletedItems : [],
      );
      setReassignmentOptions(
        Array.isArray(payload.reassignmentOptions)
          ? payload.reassignmentOptions
          : [],
      );
      setManageLoaded(true);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to load photo management.",
      );
    } finally {
      setManageLoading(false);
    }
  }, [appointmentId, canManage]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/media`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(await readError(response, "media_load_failed"));
      const payload = (await response.json()) as MediaResponse;
      if (!Array.isArray(payload.items)) {
        throw new Error("invalid_media_response");
      }
      const nextItems = payload.items;
      setItems(nextItems);
      setLegacyFiles(
        Array.isArray(payload.legacyAttachments)
          ? payload.legacyAttachments
          : [],
      );
      setScope(payload.quotedScopeText ?? initialScope ?? "");
      if (payload.mediaSummary) {
        setSummary(payload.mediaSummary);
        onScopeRequirementChange?.(payload.mediaSummary.needsScope);
      }
      setCaptionDrafts(
        Object.fromEntries(
          nextItems.map((item) => [item.id, item.caption ?? ""]),
        ),
      );
      await cacheAppointmentMedia(
        employeeId,
        appointmentId,
        nextItems.map((item) => ({
          ...item,
          orderIndex: item.sortOrder,
        })),
      );
    } catch {
      const cached = await getCachedAppointmentMedia(
        employeeId,
        appointmentId,
      ).catch(() => []);
      for (const url of cachedObjectUrls.current) URL.revokeObjectURL(url);
      const urls = cached.map((item) => URL.createObjectURL(item.blob));
      cachedObjectUrls.current = urls;
      setItems(
        cached.map((item, index) => ({
          id: item.mediaId,
          status: "ready",
          caption: item.caption,
          sortOrder: item.orderIndex,
          isCover: item.isCover,
          source: item.source,
          filename: null,
          contentType: item.contentType,
          thumbnailUrl: urls[index] ?? null,
          displayUrl: urls[index] ?? null,
          originalUrl: urls[index] ?? null,
        })),
      );
      if (!cached.length)
        setMessage("Quoted-work photos are unavailable right now.");
    } finally {
      setLoaded(true);
      setLoading(false);
      await refreshQueue();
    }
  }, [
    appointmentId,
    employeeId,
    initialScope,
    onScopeRequirementChange,
    refreshQueue,
  ]);

  React.useEffect(
    () => () => {
      for (const url of cachedObjectUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  React.useEffect(() => {
    const onQueueChange = () => {
      void refreshQueue();
      void syncQueuedMedia(employeeId).catch(() => undefined);
      if (loaded) void load();
    };
    const queueTimer = window.setInterval(() => {
      void refreshQueue();
    }, 60_000);
    window.addEventListener(MOBILE_MEDIA_QUEUE_EVENT, onQueueChange);
    return () => {
      window.removeEventListener(MOBILE_MEDIA_QUEUE_EVENT, onQueueChange);
      window.clearInterval(queueTimer);
    };
  }, [employeeId, load, loaded, refreshQueue]);

  const addFiles = async (files: FileList | null, input: HTMLInputElement) => {
    try {
      if (!files?.length) return;
      setMessage(null);
      const selected = Array.from(files);
      if (selected.length > 10) {
        setMessage("Choose no more than 10 photos at a time.");
        return;
      }
      setBusy("upload");
      for (const file of selected) {
        try {
          await queueMediaUpload({
            employeeId,
            appointmentId,
            file,
            capturedOffline: false,
            caption: newCaption,
            quotedScopeText: canManage ? scope : null,
          });
        } catch (error) {
          setMessage(friendlyError(error));
        }
      }
      await refreshQueue();
      await syncQueuedMedia(employeeId).catch(() => undefined);
      await refreshQueue();
      await load();
    } finally {
      input.value = "";
      setBusy(null);
    }
  };

  const saveScope = async () => {
    const nextScope = scope.trim();
    if (!nextScope) {
      setMessage("Add the quoted-to-remove summary before saving.");
      return;
    }
    setBusy("scope");
    const response = await fetch(
      `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/quoted-scope`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quotedScopeText: nextScope }),
      },
    );
    if (!response.ok) {
      setMessage(await readError(response, "Unable to save the scope."));
    } else {
      setSummary((current) => ({ ...current, needsScope: false }));
      onScopeRequirementChange?.(false);
      setMessage("Quoted scope saved.");
    }
    setBusy(null);
  };

  const updateMedia = async (
    mediaId: string,
    patch: Record<string, unknown>,
  ) => {
    setBusy(mediaId);
    setMessage(null);
    const response = await fetch(
      `/api/mobile/appointment-media/${encodeURIComponent(mediaId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!response.ok) {
      setMessage(await readError(response, "Unable to update that photo."));
    } else {
      await load();
    }
    setBusy(null);
  };

  const removeMedia = async (mediaId: string) => {
    if (
      !window.confirm(
        "Remove this photo from the appointment? It can be recovered for 30 days.",
      )
    ) {
      return;
    }
    setBusy(mediaId);
    const response = await fetch(
      `/api/mobile/appointment-media/${encodeURIComponent(mediaId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      setMessage(await readError(response, "Unable to remove that photo."));
    } else {
      await load();
      await loadManageData();
    }
    setBusy(null);
  };

  const restoreMedia = async (mediaId: string) => {
    setBusy(`restore:${mediaId}`);
    setMessage(null);
    const response = await fetch(
      `/api/mobile/appointment-media/${encodeURIComponent(mediaId)}/restore`,
      { method: "POST" },
    );
    if (!response.ok) {
      setMessage(await readError(response, "Unable to restore that photo."));
    } else {
      await Promise.all([load(), loadManageData()]);
      setMessage("Photo restored.");
    }
    setBusy(null);
  };

  const reassignMedia = async (mediaId: string) => {
    const destinationId = reassignmentDrafts[mediaId];
    if (!destinationId) {
      setMessage("Choose an appointment before moving the photo.");
      return;
    }
    const destination = reassignmentOptions.find(
      (option) => option.appointmentId === destinationId,
    );
    if (
      !window.confirm(
        `Move this photo to ${destination ? destinationLabel(destination) : "the selected appointment"}?`,
      )
    ) {
      return;
    }
    setBusy(`reassign:${mediaId}`);
    setMessage(null);
    const response = await fetch(
      `/api/mobile/appointment-media/${encodeURIComponent(mediaId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appointmentId: destinationId }),
      },
    );
    if (!response.ok) {
      setMessage(await readError(response, "Unable to move that photo."));
    } else {
      setReassignmentDrafts((current) => {
        const next = { ...current };
        delete next[mediaId];
        return next;
      });
      await Promise.all([load(), loadManageData()]);
      setMessage("Photo moved to the selected appointment.");
    }
    setBusy(null);
  };

  return (
    <>
      <details
        className={`rounded-md border p-3 ${
          summary.needsScope
            ? "border-amber-300/40 bg-amber-300/10"
            : "border-white/10 bg-slate-950"
        }`}
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          if (!loaded) void load();
          if (canManage && !manageLoaded) void loadManageData();
        }}
      >
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">Quoted Work</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {summary.readyCount} photo{summary.readyCount === 1 ? "" : "s"}
                {summary.pendingCount
                  ? ` · ${summary.pendingCount} processing`
                  : ""}
              </p>
            </div>
            {summary.needsScope ? (
              <span className="rounded-full bg-amber-300 px-2 py-1 text-[11px] font-semibold text-slate-950">
                Scope needed
              </span>
            ) : (
              <span className="text-xs font-semibold text-cyan-100">Open</span>
            )}
          </div>
        </summary>

        <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
          {loading ? (
            <p className="text-sm text-slate-400">Loading quoted work…</p>
          ) : null}
          {message ? (
            <p
              role="status"
              className="rounded-md border border-cyan-300/20 bg-cyan-300/10 p-2 text-xs leading-5 text-cyan-100"
            >
              {message}
            </p>
          ) : null}

          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              Quoted to remove
            </p>
            {canManage ? (
              <>
                <textarea
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                  maxLength={4000}
                  rows={4}
                  className="mt-2 w-full resize-y rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base leading-6 text-white outline-none focus:border-cyan-300"
                  placeholder="Example: Remove the sectional, two mattresses, and boxed garage items shown below."
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">
                    {scope.length}/4,000
                  </span>
                  <button
                    type="button"
                    disabled={busy === "scope"}
                    onClick={() => void saveScope()}
                    className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                  >
                    {busy === "scope" ? "Saving…" : "Save scope"}
                  </button>
                </div>
              </>
            ) : (
              <p
                className={`mt-2 whitespace-pre-wrap rounded-md border p-3 text-sm leading-6 ${
                  scope
                    ? "border-white/10 bg-slate-900 text-slate-200"
                    : "border-amber-300/30 bg-amber-300/10 text-amber-100"
                }`}
              >
                {scope ||
                  "Quoted scope is missing. Ask the office to fill it in before payment or completion."}
              </p>
            )}
          </section>

          {items.length ? (
            <div className="grid grid-cols-2 gap-2">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  className="overflow-hidden rounded-md border border-white/10 bg-slate-900"
                >
                  <button
                    type="button"
                    disabled={!item.displayUrl && !item.originalUrl}
                    onClick={() => setViewer(item)}
                    className="relative block w-full disabled:cursor-default"
                  >
                    {item.thumbnailUrl || item.displayUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl ?? item.displayUrl ?? ""}
                        alt={item.caption || `Quoted work photo ${index + 1}`}
                        className="aspect-square w-full object-cover"
                      />
                    ) : (
                      <span className="flex aspect-square items-center justify-center px-3 text-xs text-slate-400">
                        {item.status === "failed"
                          ? item.error || "Processing failed"
                          : "Processing…"}
                      </span>
                    )}
                    {item.isCover ? (
                      <span className="absolute left-2 top-2 rounded-full bg-cyan-300 px-2 py-1 text-[10px] font-semibold text-slate-950">
                        Cover
                      </span>
                    ) : null}
                  </button>
                  <div className="space-y-2 p-2">
                    <p className="text-[11px] font-semibold text-slate-400">
                      {sourceLabel(item.source)}
                      {item.status !== "ready" ? ` · ${item.status}` : ""}
                    </p>
                    {canManage ? (
                      <>
                        <input
                          value={captionDrafts[item.id] ?? ""}
                          onChange={(event) =>
                            setCaptionDrafts((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          maxLength={500}
                          className="w-full rounded border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-white"
                          placeholder="Caption"
                        />
                        <div className="grid grid-cols-2 gap-1">
                          <button
                            type="button"
                            disabled={busy === item.id}
                            onClick={() =>
                              void updateMedia(item.id, {
                                caption: captionDrafts[item.id]?.trim() || null,
                              })
                            }
                            className="rounded border border-white/10 px-2 py-1.5 text-[11px] font-semibold text-slate-200"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            disabled={busy === item.id || item.isCover}
                            onClick={() =>
                              void updateMedia(item.id, { isCover: true })
                            }
                            className="rounded border border-cyan-300/30 px-2 py-1.5 text-[11px] font-semibold text-cyan-100 disabled:opacity-40"
                          >
                            Cover
                          </button>
                          <button
                            type="button"
                            disabled={busy === item.id || index === 0}
                            onClick={() =>
                              void updateMedia(item.id, {
                                sortOrder: Math.max(0, item.sortOrder - 1),
                              })
                            }
                            className="rounded border border-white/10 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40"
                          >
                            Earlier
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy === item.id || index === items.length - 1
                            }
                            onClick={() =>
                              void updateMedia(item.id, {
                                sortOrder: item.sortOrder + 1,
                              })
                            }
                            className="rounded border border-white/10 px-2 py-1.5 text-[11px] text-slate-300 disabled:opacity-40"
                          >
                            Later
                          </button>
                        </div>
                        <button
                          type="button"
                          disabled={busy === item.id}
                          onClick={() => void removeMedia(item.id)}
                          className="w-full rounded border border-rose-300/20 px-2 py-1.5 text-[11px] font-semibold text-rose-100"
                        >
                          Remove
                        </button>
                        {reassignmentOptions.length ? (
                          <details className="rounded border border-white/10 bg-slate-950 p-2">
                            <summary className="cursor-pointer text-[11px] font-semibold text-slate-300">
                              Move to another appointment
                            </summary>
                            <div className="mt-2 space-y-2">
                              <select
                                aria-label="Destination appointment"
                                value={reassignmentDrafts[item.id] ?? ""}
                                onChange={(event) =>
                                  setReassignmentDrafts((current) => ({
                                    ...current,
                                    [item.id]: event.target.value,
                                  }))
                                }
                                className="w-full rounded border border-white/10 bg-slate-900 px-2 py-2 text-xs text-white"
                              >
                                <option value="">Choose appointment</option>
                                {reassignmentOptions.map((option) => (
                                  <option
                                    key={option.appointmentId}
                                    value={option.appointmentId}
                                  >
                                    {destinationLabel(option)}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                disabled={
                                  busy === `reassign:${item.id}` ||
                                  !reassignmentDrafts[item.id]
                                }
                                onClick={() => void reassignMedia(item.id)}
                                className="w-full rounded border border-cyan-300/30 px-2 py-2 text-[11px] font-semibold text-cyan-100 disabled:opacity-40"
                              >
                                {busy === `reassign:${item.id}`
                                  ? "Moving…"
                                  : "Move photo"}
                              </button>
                            </div>
                          </details>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-xs leading-5 text-slate-300">
                        {item.caption || "Quoted work"}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : loaded && !loading ? (
            <p className="rounded-md border border-dashed border-white/10 p-3 text-sm text-slate-400">
              No quoted-work photos yet.
            </p>
          ) : null}

          {canCapture ? (
            <section className="space-y-2">
              <label className="block">
                <span className="text-xs font-semibold text-slate-300">
                  Caption for new photos (optional)
                </span>
                <input
                  value={newCaption}
                  onChange={(event) => setNewCaption(event.target.value)}
                  maxLength={500}
                  className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white"
                  placeholder="Items behind the shed"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="cursor-pointer rounded-md bg-cyan-300 px-3 py-3 text-center text-sm font-semibold text-slate-950">
                  {busy === "upload" ? "Preparing…" : "Take photos"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                    capture="environment"
                    disabled={busy === "upload"}
                    className="sr-only"
                    onChange={(event) => {
                      const input = event.currentTarget;
                      void addFiles(input.files, input);
                    }}
                  />
                </label>
                <label className="cursor-pointer rounded-md border border-cyan-300/40 bg-slate-900 px-3 py-3 text-center text-sm font-semibold text-cyan-100">
                  Choose photos
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                    multiple
                    disabled={busy === "upload"}
                    className="sr-only"
                    onChange={(event) => {
                      const input = event.currentTarget;
                      void addFiles(input.files, input);
                    }}
                  />
                </label>
              </div>
            </section>
          ) : null}

          {queue.length ? (
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">
                Upload queue
              </p>
              {queue.map((item) => (
                <div
                  key={item.clientId}
                  className="rounded-md border border-white/10 bg-slate-900 p-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-200">
                        {item.filename}
                      </p>
                      <p className="mt-1 capitalize text-slate-400">
                        {item.status}
                        {item.error ? ` · ${item.error}` : ""}
                      </p>
                    </div>
                    {item.status === "failed" || isInterruptedQueueRow(item) ? (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void retryQueuedMedia(item.clientId).then(() =>
                              syncQueuedMedia(employeeId),
                            );
                          }}
                          className="rounded border border-cyan-300/30 px-2 py-1 font-semibold text-cyan-100"
                        >
                          Retry
                        </button>
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
                          className="rounded border border-rose-300/20 px-2 py-1 font-semibold text-rose-100"
                        >
                          Discard
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          {canManage && (manageLoading || manageLoaded) ? (
            <details className="rounded-md border border-white/10 bg-slate-900 p-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-300">
                Removed photos (recoverable for 30 days)
                {deletedItems.length ? ` (${deletedItems.length})` : ""}
              </summary>
              <div className="mt-2 space-y-2">
                {manageLoading && !manageLoaded ? (
                  <p className="text-xs text-slate-400">
                    Loading removed photos…
                  </p>
                ) : null}
                {manageLoaded && !manageLoading && !deletedItems.length ? (
                  <p className="text-xs text-slate-400">
                    No photos were removed in the last 30 days.
                  </p>
                ) : null}
                {deletedItems.map((item) => (
                  <div
                    key={item.id}
                    className="rounded border border-white/10 bg-slate-950 p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-slate-200">
                          {item.caption || item.filename || "Quoted-work photo"}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {sourceLabel(item.source)} · Removed{" "}
                          {new Date(item.deletedAt).toLocaleDateString(
                            "en-US",
                            {
                              timeZone: "America/New_York",
                              month: "short",
                              day: "numeric",
                            },
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy === `restore:${item.id}`}
                        onClick={() => void restoreMedia(item.id)}
                        className="shrink-0 rounded border border-cyan-300/30 px-2 py-1.5 text-[11px] font-semibold text-cyan-100 disabled:opacity-40"
                      >
                        {busy === `restore:${item.id}`
                          ? "Restoring…"
                          : "Restore"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          {legacyFiles.length ? (
            <details className="rounded-md border border-white/10 bg-slate-900 p-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-300">
                Legacy files ({legacyFiles.length})
              </summary>
              <div className="mt-2 space-y-1">
                {legacyFiles.map((file) => (
                  <a
                    key={file.id}
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate rounded border border-white/10 px-2 py-2 text-xs text-cyan-100"
                  >
                    {file.filename || "Attachment"}
                  </a>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </details>

      {viewer ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={viewer.caption || "Quoted work photo"}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4"
          onClick={() => setViewer(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full border border-white/20 bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
            onClick={() => setViewer(null)}
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={viewer.displayUrl ?? viewer.originalUrl ?? ""}
            alt={viewer.caption || "Quoted work"}
            className="max-h-full max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
          {viewer.caption ? (
            <p className="absolute bottom-4 left-4 right-4 rounded-md bg-slate-950/80 p-3 text-center text-sm text-white">
              {viewer.caption}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
