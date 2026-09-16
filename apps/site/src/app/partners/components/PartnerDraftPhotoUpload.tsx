"use client";

import * as React from "react";
import {
  Camera,
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type { PartnerProofMedia } from "../lib/portal-v2";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import { trackPartnerFunnelEvent } from "../lib/product-analytics";
import {
  PortalFileUploadError,
  preparePortalImageForUpload,
  uploadPortalFileWithProgress,
} from "../lib/upload-with-progress";
import {
  PartnerSelectedPhotoPreviews,
  type PartnerSelectedPhotoStatus,
} from "./PartnerSelectedPhotoPreviews";
import { isPortalProofMedia } from "../lib/portal-read-models";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const ACCEPTED_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif)$/iu;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type UploadIntent = {
  id: string;
  status: string;
  alreadyExists: boolean;
  requiresUpload: boolean;
  uploadIntent: {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
  } | null;
};

type MediaState = "loading" | "ready" | "forbidden" | "unavailable" | "error";

export type DraftPhotoUploadPhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "uploading"
  | "saving"
  | "attached"
  | "error";

function validFile(file: File): boolean {
  return (
    file.size > 0 &&
    file.size <= MAX_FILE_BYTES &&
    (ACCEPTED_TYPES.has(file.type) ||
      (!file.type && ACCEPTED_EXTENSIONS.test(file.name)))
  );
}

function formatBytes(value: number | null): string {
  if (!value) return "Size unavailable";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

function declaredContentType(file: File): string {
  if (file.type) return file.type;
  const filename = file.name.toLowerCase();
  if (/\.jpe?g$/u.test(filename)) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return filename.endsWith(".heic") ? "image/heic" : "image/heif";
}

export function PartnerDraftPhotoUpload({
  draftId,
  canUpload,
  onCountChange,
  onPendingChange,
  onPhaseChange,
  persona,
  compact = false,
}: {
  draftId: string;
  canUpload: boolean;
  onCountChange: (count: number | null) => void;
  onPendingChange?: (pending: boolean) => void;
  onPhaseChange?: (phase: DraftPhotoUploadPhase) => void;
  persona?: string | null;
  compact?: boolean;
}) {
  const [state, setState] = React.useState<MediaState>("loading");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [media, setMedia] = React.useState<PartnerProofMedia[]>([]);
  const [files, setFiles] = React.useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = React.useState<number[]>([]);
  const [uploadStatuses, setUploadStatuses] = React.useState<
    PartnerSelectedPhotoStatus[]
  >([]);
  const [phase, setPhase] = React.useState<DraftPhotoUploadPhase>("idle");
  const [category, setCategory] = React.useState("intake");
  const [caption, setCaption] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [preparingFiles, setPreparingFiles] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const mediaRef = React.useRef<PartnerProofMedia[]>([]);
  const uploadClientIdsRef = React.useRef<string[]>([]);
  const uploadOperationKeyRef = React.useRef<string | null>(null);
  const finalizeOperationKeysRef = React.useRef(new Map<string, string>());
  const batchGenerationRef = React.useRef(0);
  const batchIntentIdsRef = React.useRef<string[] | null>(null);
  const busyRef = React.useRef(false);
  const [uploadAttemptStarted, setUploadAttemptStarted] = React.useState(false);

  React.useEffect(() => {
    onPendingChange?.(
      files.length > 0 || busy || preparingFiles || deletingId !== null,
    );
  }, [files.length, busy, preparingFiles, deletingId, onPendingChange]);
  React.useEffect(() => onPhaseChange?.(phase), [phase, onPhaseChange]);

  const setUploadBusy = React.useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  const resetUploadAttempt = React.useCallback(() => {
    batchGenerationRef.current += 1;
    batchIntentIdsRef.current = null;
    uploadOperationKeyRef.current = null;
    finalizeOperationKeysRef.current.clear();
    setUploadAttemptStarted(false);
  }, []);

  const finishAttachedBatch = React.useCallback(() => {
    setFiles([]);
    setUploadProgress([]);
    setUploadStatuses([]);
    uploadClientIdsRef.current = [];
    resetUploadAttempt();
    setUploadBusy(false);
    setPhase("attached");
    setCaption("");
    if (inputRef.current) inputRef.current.value = "";
    setMessage({
      tone: "success",
      text: "Photos attached to this saved request.",
    });
    trackPartnerFunnelEvent({
      stage: "upload_completed",
      persona,
      surface: "draft_upload",
    });
  }, [persona, resetUploadAttempt, setUploadBusy]);

  const refresh = React.useCallback(async (): Promise<boolean> => {
    const generation = batchGenerationRef.current;
    const expectedIds = batchIntentIdsRef.current;
    if (expectedIds) {
      setUploadBusy(true);
      setPhase("saving");
    }
    const result = await partnerPortalFetch<{
      ok: true;
      media: PartnerProofMedia[];
    }>(`booking-drafts/${draftId}/media`).catch(() => null);
    // A late read from an earlier selection cannot complete or replace this batch.
    if (generation !== batchGenerationRef.current) return false;
    if (!result?.ok) {
      if (expectedIds) {
        setUploadBusy(false);
        setPhase("error");
        setUploadStatuses((current) =>
          current.map((value) => (value === "attached" ? value : "error")),
        );
      }
      onCountChange(null);
      const status = result?.response.status ?? 503;
      setState(
        status === 403
          ? "forbidden"
          : [404, 409, 501, 503].includes(status)
            ? "unavailable"
            : "error",
      );
      setLoadError(
        result?.error.message ??
          "Attached photos could not be loaded. Please try again before adding files.",
      );
      return false;
    }
    if (
      !Array.isArray(result.data.media) ||
      !result.data.media.every(isPortalProofMedia)
    ) {
      if (expectedIds) {
        setUploadBusy(false);
        setPhase("error");
        setUploadStatuses((current) =>
          current.map((value) => (value === "attached" ? value : "error")),
        );
      }
      onCountChange(null);
      setState("error");
      setLoadError(
        withPortalSupportReference(
          "Attached photos could not be loaded. Please try again before adding files.",
          portalSupportReferenceFromResponse(result.response),
        ),
      );
      return false;
    }
    mediaRef.current = result.data.media;
    setMedia(result.data.media);
    onCountChange(
      result.data.media.filter((item) => item.status === "ready").length,
    );
    setState("ready");
    setLoadError(null);
    if (expectedIds) {
      const attachedIds = new Set(
        result.data.media
          .filter((item) => item.status === "ready")
          .map((item) => item.id),
      );
      if (expectedIds.every((id) => attachedIds.has(id))) {
        finishAttachedBatch();
      } else {
        setUploadBusy(false);
        setPhase("error");
        setUploadStatuses(
          expectedIds.map((id) => (attachedIds.has(id) ? "attached" : "error")),
        );
        setMessage({
          tone: "error",
          text: "Some photos are not attached yet. Retry the unfinished photos to safely check the same files.",
        });
      }
    }
    return true;
  }, [draftId, onCountChange, finishAttachedBatch, setUploadBusy]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const chooseFiles = async (list: FileList | null): Promise<void> => {
    if (busyRef.current || preparingFiles || deletingId) return;
    const selected = Array.from(list ?? []);
    if (!selected.length) return;
    if (selected.length > 10) {
      setMessage({
        tone: "error",
        text: "Choose no more than 10 photos in one batch.",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const invalid = selected.find((file) => !validFile(file));
    if (invalid) {
      setMessage({
        tone: "error",
        text: `${invalid.name} is not a supported image under 10 MB.`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setPreparingFiles(true);
    setPhase("preparing");
    setMessage(null);
    let prepared: Awaited<ReturnType<typeof preparePortalImageForUpload>>[];
    try {
      prepared = await Promise.all(
        selected.map((file) => preparePortalImageForUpload(file)),
      );
    } catch {
      setPreparingFiles(false);
      setPhase(files.length ? "error" : "idle");
      setMessage({
        tone: "error",
        text: "These photos could not be prepared. Try selecting them again. Your previous selection is still here.",
      });
      return;
    }
    const uploadFiles = prepared.map((item) => item.file);
    setFiles(uploadFiles);
    setUploadProgress(uploadFiles.map(() => 0));
    setUploadStatuses(uploadFiles.map(() => "ready"));
    uploadClientIdsRef.current = selected.map(
      () => `photo_${crypto.randomUUID().replace(/-/gu, "")}`,
    );
    resetUploadAttempt();
    setPreparingFiles(false);
    setPhase("ready");
    const compressedCount = prepared.filter((item) => item.compressed).length;
    if (compressedCount > 0) {
      setMessage({
        tone: "success",
        text:
          String(compressedCount) +
          " large photo" +
          (compressedCount === 1 ? " was" : "s were") +
          " optimized for a faster private upload.",
      });
    }
  };

  const upload = async (): Promise<void> => {
    if (busyRef.current || preparingFiles || deletingId) return;
    if (!files.length) {
      setMessage({
        tone: "error",
        text: "Choose at least one photo to attach.",
      });
      inputRef.current?.focus();
      return;
    }
    setUploadBusy(true);
    setPhase("starting");
    setUploadStatuses((current) =>
      current.map((value) => (value === "attached" ? value : "ready")),
    );
    const generation = batchGenerationRef.current;
    setUploadAttemptStarted(true);
    setMessage(null);
    trackPartnerFunnelEvent({
      stage: "upload_started",
      persona,
      surface: "draft_upload",
    });
    const operationKey =
      uploadOperationKeyRef.current ??
      createPortalOperationKey("draft-photo-upload");
    uploadOperationKeyRef.current = operationKey;
    const result = await partnerPortalFetch<{
      ok: true;
      intents: UploadIntent[];
    }>(`booking-drafts/${draftId}/media/upload-intents`, {
      method: "POST",
      headers: {
        "Idempotency-Key": operationKey,
      },
      body: JSON.stringify({
        files: files.map((file, index) => ({
          clientId:
            uploadClientIdsRef.current[index] ??
            `photo_${crypto.randomUUID().replace(/-/gu, "")}`,
          filename: file.name,
          contentType: declaredContentType(file),
          byteLength: file.size,
          checksumSha256: null,
          category,
          caption: caption.trim() || null,
        })),
      }),
    }).catch(() => null);
    if (!result?.ok) {
      trackPartnerFunnelEvent({
        stage: "upload_failed",
        persona,
        surface: "draft_upload",
      });
      setUploadBusy(false);
      setPhase("error");
      setUploadStatuses((current) =>
        current.map((value) => (value === "attached" ? value : "error")),
      );
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The photo upload could not be started.",
      });
      return;
    }

    const supportReference = portalSupportReferenceFromResponse(
      result.response,
    );
    let finalizedFailure: string | null = null;
    try {
      if (
        !Array.isArray(result.data.intents) ||
        result.data.intents.length !== files.length ||
        result.data.intents.some(
          (intent) =>
            !intent ||
            typeof intent.id !== "string" ||
            !intent.id ||
            typeof intent.status !== "string" ||
            typeof intent.requiresUpload !== "boolean" ||
            typeof intent.alreadyExists !== "boolean",
        ) ||
        new Set(result.data.intents.map((intent) => intent.id)).size !==
          files.length
      ) {
        throw new Error("upload_intent_count_mismatch");
      }
      batchIntentIdsRef.current = result.data.intents.map(
        (intent) => intent.id,
      );
      for (const [index, intent] of result.data.intents.entries()) {
        if (intent.status === "ready") {
          setPhase("saving");
          setUploadStatuses((current) =>
            current.map((value, itemIndex) =>
              itemIndex === index ? "saving" : value,
            ),
          );
          setUploadProgress((current) =>
            current.map((value, itemIndex) =>
              itemIndex === index ? 100 : value,
            ),
          );
          continue;
        }
        const file = files[index];
        if (!file) throw new Error("upload_intent_incomplete");
        if (intent.requiresUpload) {
          if (!intent.uploadIntent) {
            throw new Error("upload_intent_incomplete");
          }
          setPhase("uploading");
          setUploadStatuses((current) =>
            current.map((value, itemIndex) =>
              itemIndex === index ? "uploading" : value,
            ),
          );
          await uploadPortalFileWithProgress({
            url: intent.uploadIntent.url,
            method: intent.uploadIntent.method,
            headers: intent.uploadIntent.headers,
            file,
            onProgress: ({ percent }) => {
              setUploadProgress((current) =>
                current.map((value, itemIndex) =>
                  itemIndex === index ? percent : value,
                ),
              );
            },
          });
        }
        setPhase("saving");
        setUploadProgress((current) =>
          current.map((value, itemIndex) =>
            itemIndex === index ? 100 : value,
          ),
        );
        setUploadStatuses((current) =>
          current.map((value, itemIndex) =>
            itemIndex === index ? "saving" : value,
          ),
        );
        const finalizeOperationKey =
          finalizeOperationKeysRef.current.get(intent.id) ??
          createPortalOperationKey("draft-photo-finalize");
        finalizeOperationKeysRef.current.set(intent.id, finalizeOperationKey);
        const finalized = await partnerPortalFetch<{
          ok: true;
          media: PartnerProofMedia;
        }>(`booking-drafts/${draftId}/media/${intent.id}/finalize`, {
          method: "POST",
          headers: {
            "Idempotency-Key": finalizeOperationKey,
          },
          body: JSON.stringify({ checksumSha256: null }),
        });
        if (!finalized.ok) {
          finalizedFailure = finalized.error.message;
          throw new Error("finalize_failed");
        }
      }
    } catch (error) {
      const interrupted =
        error instanceof PortalFileUploadError &&
        error.code === "storage_upload_interrupted";
      trackPartnerFunnelEvent({
        stage: interrupted ? "upload_interrupted" : "upload_failed",
        persona,
        surface: "draft_upload",
      });
      await refresh();
      if (generation !== batchGenerationRef.current) return;
      setUploadBusy(false);
      setPhase("error");
      setUploadStatuses((current) =>
        current.map((value) => (value === "attached" ? value : "error")),
      );
      setMessage({
        tone: "error",
        text:
          finalizedFailure ??
          withPortalSupportReference(
            interrupted
              ? "The photo transfer was interrupted. Attached photos are shown below; retry the unfinished files."
              : "One or more photos did not finish. Attached photos are shown below; retry the others.",
            supportReference,
          ),
      });
      return;
    }

    // Keep the retry identity and selected files until the saved photos are
    // confirmed by a read. A successful transfer alone does not prove attachment.
    await refresh();
    if (generation !== batchGenerationRef.current) return;
    setUploadBusy(false);
    setPhase("error");
    setMessage({
      tone: "error",
      text: "Your photos were transferred, but we could not confirm they were attached. Try again to check the same photos safely.",
    });
  };

  const remove = async (item: PartnerProofMedia): Promise<void> => {
    if (busyRef.current || preparingFiles || deletingId) return;
    setDeletingId(item.id);
    setPhase("saving");
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true }>(
      `booking-drafts/${draftId}/media/${item.id}`,
      { method: "DELETE" },
    ).catch(() => null);
    setDeletingId(null);
    if (!result?.ok) {
      setPhase("error");
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The photo was not removed.",
      });
      return;
    }
    const next = mediaRef.current.filter(
      (mediaItem) => mediaItem.id !== item.id,
    );
    mediaRef.current = next;
    setMedia(next);
    onCountChange(next.filter((item) => item.status === "ready").length);
    setPhase(files.length ? "ready" : "idle");
    setMessage({ tone: "success", text: "Photo removed from this request." });
  };

  const heading = (
    <div className={cn("flex items-start gap-3", compact && "gap-2")}>
      {!compact ? (
        <Camera
          className="mt-0.5 h-5 w-5 shrink-0 text-primary-700"
          aria-hidden="true"
        />
      ) : null}
      <div>
        <h3
          id={`draft-photos-${draftId}`}
          className="font-semibold text-slate-950"
        >
          {compact ? "Photos" : "Attach reference photos"}
          {compact ? (
            <span className="ml-2 text-sm font-normal text-slate-500">
              Optional
            </span>
          ) : null}
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          {compact
            ? "Choose photos, then attach them to this request."
            : "Show current conditions, items, access constraints, or an issue. Photos stay private and transfer to the job when you submit."}
        </p>
      </div>
    </div>
  );
  const categoryField = (
    <label htmlFor={`draft-photo-category-${draftId}`}>
      <span className="text-sm font-semibold text-slate-700">
        Photo category
      </span>
      <select
        id={`draft-photo-category-${draftId}`}
        value={category}
        onChange={(event) => setCategory(event.target.value)}
        disabled={busy || uploadAttemptStarted}
        className={partnerFieldClass}
      >
        <option value="intake">Reference / intake</option>
        <option value="before">Before condition</option>
        <option value="issue">Issue or access concern</option>
      </select>
    </label>
  );
  const captionField = (
    <label
      className={compact ? undefined : "sm:col-span-2"}
      htmlFor={`draft-photo-caption-${draftId}`}
    >
      <span className="text-sm font-semibold text-slate-700">
        Batch note{" "}
        <span className="font-normal text-slate-500">(optional)</span>
      </span>
      <input
        id={`draft-photo-caption-${draftId}`}
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
        disabled={busy || uploadAttemptStarted}
        maxLength={500}
        className={partnerFieldClass}
        placeholder="What should the crew notice in these photos?"
      />
    </label>
  );
  const fileInput = (
    <input
      ref={inputRef}
      id={`draft-photo-files-${draftId}`}
      type="file"
      multiple
      accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
      onChange={(event) => void chooseFiles(event.target.files)}
      disabled={busy || preparingFiles}
      aria-label={compact ? "Photos" : undefined}
      tabIndex={compact ? -1 : undefined}
      className={
        compact
          ? "sr-only"
          : `${partnerFieldClass} file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:font-semibold file:text-primary-800`
      }
    />
  );

  if (state === "loading") {
    const loading = (
      <div
        className="flex min-h-24 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-600"
        role="status"
      >
        <LoaderCircle
          className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        Loading attached photos…
      </div>
    );
    return compact ? (
      <section
        aria-labelledby={`draft-photos-${draftId}`}
        className="space-y-3"
      >
        {heading}
        {loading}
      </section>
    ) : (
      loading
    );
  }
  if (state !== "ready" && media.length === 0 && files.length === 0) {
    const error = (
      <PartnerNotice tone={state === "error" ? "error" : "warning"}>
        {loadError ??
          (state === "forbidden"
            ? "Your role can request proof but cannot view or upload booking photos."
            : state === "unavailable"
              ? "Photos could not be loaded right now. Please try again before adding files. You can continue your request without photos."
              : "Attached photos could not be loaded. Refresh before adding files.")}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || preparingFiles || deletingId !== null}
          className={cn(partnerPrimaryButtonClass, "mt-3")}
        >
          Try again
        </button>
      </PartnerNotice>
    );
    return compact ? (
      <section
        aria-labelledby={`draft-photos-${draftId}`}
        className="space-y-3"
      >
        {heading}
        {error}
      </section>
    ) : (
      error
    );
  }

  return (
    <section
      aria-labelledby={`draft-photos-${draftId}`}
      className={
        compact
          ? undefined
          : "rounded-2xl border border-primary-200 bg-primary-50/40 p-4 sm:p-5"
      }
    >
      {heading}
      {message ? (
        <PartnerNotice tone={message.tone} className="mt-4">
          {message.text}
        </PartnerNotice>
      ) : null}
      {loadError ? (
        <PartnerNotice tone="warning" className="mt-4">
          {loadError} Your last loaded photos are still shown.
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy || preparingFiles || deletingId !== null}
            className={cn(partnerPrimaryButtonClass, "mt-3")}
          >
            Try again
          </button>
        </PartnerNotice>
      ) : null}
      {canUpload && (state === "ready" || files.length > 0) ? (
        <div
          className={
            compact ? "mt-3 space-y-3" : "mt-4 grid gap-4 sm:grid-cols-2"
          }
        >
          {compact ? (
            <div className="flex min-h-[88px] flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={busy || preparingFiles}
                  className={partnerSecondaryButtonClass}
                >
                  <Camera className="h-4 w-4" aria-hidden="true" />
                  {files.length ? "Choose different photos" : "Choose photos"}
                </button>
                {fileInput}
              </div>
              <p className="text-xs leading-5 text-slate-500">
                JPEG, PNG, WebP, HEIC/HEIF · Up to 10 photos, 10 MB each
                <span className="block">
                  PDF uploads are not available yet.
                </span>
              </p>
            </div>
          ) : (
            <>
              {categoryField}
              <label htmlFor={`draft-photo-files-${draftId}`}>
                <span className="text-sm font-semibold text-slate-700">
                  Photos
                </span>
                {fileInput}
              </label>
              {captionField}
            </>
          )}
          {!compact || files.length > 0 || preparingFiles ? (
            <div className="sm:col-span-2">
              {!compact ? (
                <p className="text-xs leading-5 text-slate-500">
                  JPEG, PNG, WebP, HEIC, or HEIF. Up to 10 photos per batch and
                  10 MB each.
                  <span className="block">
                    PDF uploads are not available yet.
                  </span>
                </p>
              ) : null}
              {uploadAttemptStarted && !busy ? (
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  Retry keeps this batch’s files, category, and note unchanged
                  so already-uploaded photos can resume safely. Choose files
                  again to start a new batch.
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void upload()}
                disabled={busy || preparingFiles || !files.length}
                className={cn(
                  partnerPrimaryButtonClass,
                  "mt-3 w-full sm:w-auto",
                )}
                data-partner-analytics="draft_photo_upload"
              >
                {busy || preparingFiles ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Upload className="h-4 w-4" aria-hidden="true" />
                )}
                {preparingFiles
                  ? "Preparing photos…"
                  : busy
                    ? phase === "saving"
                      ? "Saving photos…"
                      : phase === "starting"
                        ? "Starting upload…"
                        : "Uploading photos…"
                    : uploadAttemptStarted
                      ? "Retry photos"
                      : "Attach photos"}
              </button>
              {files.length > 0 && !busy && !preparingFiles ? (
                <button
                  type="button"
                  className={cn(
                    partnerSecondaryButtonClass,
                    "mt-3 w-full sm:ml-2 sm:w-auto",
                  )}
                  onClick={() => {
                    if (busyRef.current || preparingFiles || deletingId) return;
                    setFiles([]);
                    setUploadProgress([]);
                    setUploadStatuses([]);
                    setPhase("idle");
                    uploadClientIdsRef.current = [];
                    resetUploadAttempt();
                    setCaption("");
                    setMessage(null);
                    if (inputRef.current) inputRef.current.value = "";
                  }}
                >
                  Clear selection
                </button>
              ) : null}
              {files.length ? (
                <>
                  <p className="mt-1 text-sm text-slate-700">
                    {files.length} photo{files.length === 1 ? "" : "s"} selected
                    {phase === "starting"
                      ? " · Starting upload"
                      : phase === "uploading"
                        ? " · Uploading"
                        : phase === "saving"
                          ? " · Saving"
                          : phase === "error"
                            ? " · Needs retry"
                            : " · Ready to attach"}
                  </p>
                  <PartnerSelectedPhotoPreviews
                    files={files}
                    clientIds={uploadClientIdsRef.current}
                    progress={uploadProgress}
                    statuses={uploadStatuses}
                    label="Selected booking photo previews and upload progress"
                  />
                  {compact ? (
                    <details className="mt-3 border-t border-slate-200 pt-1">
                      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-700">
                        Photo details (optional)
                        {category !== "intake" || caption.trim() ? (
                          <span className="ml-2 font-normal text-slate-500">
                            Details added
                          </span>
                        ) : null}
                      </summary>
                      <div className="grid gap-3 pb-2 sm:grid-cols-2">
                        {categoryField}
                        {captionField}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <PartnerNotice tone="info" className="mt-4">
          You can view attached photos. Adding or removing photos is not
          available right now.
        </PartnerNotice>
      )}

      {media.length ? (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {media.map((item) => {
            const preview =
              item.downloadIntent?.thumbnailUrl ??
              item.downloadIntent?.displayUrl;
            return (
              <li
                key={item.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <div className="flex aspect-[4/3] items-center justify-center bg-slate-100">
                  {preview ? (
                    // Signed account media intentionally bypasses image optimization.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt={
                        item.caption?.trim() || "Attached job reference photo"
                      }
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <ImageIcon
                      className="h-8 w-8 text-slate-400"
                      aria-hidden="true"
                    />
                  )}
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold text-slate-950">
                    {item.filename ?? "Photo"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatBytes(item.byteSize)}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-xs font-medium",
                      item.status === "ready"
                        ? "text-emerald-700"
                        : "text-amber-800",
                    )}
                  >
                    {item.status === "ready"
                      ? "Attached"
                      : item.status === "failed"
                        ? "Upload needs retry"
                        : "Attachment not finished"}
                  </p>
                  {item.caption ? (
                    <p className="mt-2 text-sm leading-5 text-slate-600">
                      {item.caption}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.downloadIntent?.originalUrl ? (
                      <a
                        href={item.downloadIntent.originalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={partnerSecondaryButtonClass}
                      >
                        Open
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      </a>
                    ) : null}
                    {canUpload && state === "ready" ? (
                      <button
                        type="button"
                        onClick={() => void remove(item)}
                        disabled={busy || preparingFiles || deletingId !== null}
                        className={cn(
                          partnerSecondaryButtonClass,
                          "text-rose-800",
                        )}
                      >
                        {deletingId === item.id ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : compact ? null : (
        <p className="mt-4 text-sm leading-6 text-slate-600">
          No photos attached yet. This is optional unless your account’s service
          rules require them.
        </p>
      )}
    </section>
  );
}
