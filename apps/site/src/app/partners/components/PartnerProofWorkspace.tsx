"use client";

import * as React from "react";
import {
  Camera,
  CheckCircle2,
  ExternalLink,
  FileArchive,
  ImageIcon,
  Link2,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type { PartnerProof, PartnerProofMedia } from "../lib/portal-v2";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import { trackPartnerFunnelEvent } from "../lib/product-analytics";
import {
  PortalFileUploadError,
  uploadPortalFileWithProgress,
} from "../lib/upload-with-progress";
import {
  PartnerEmptyState,
  PartnerNotice,
  PartnerStatusBadge,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";
import { PartnerDocumentDownloadButton } from "./PartnerDocumentDownloadButton";
import { PartnerBeforeAfterCompare } from "./PartnerBeforeAfterCompare";
import { PartnerSelectedPhotoPreviews } from "./PartnerSelectedPhotoPreviews";

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
    expiresAt: string;
  } | null;
};

function humanize(value: string): string {
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
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

export function PartnerProofWorkspace({
  jobId,
  initialProof,
  canUpload,
  canShare,
  persona,
}: {
  jobId: string;
  initialProof: PartnerProof;
  canUpload: boolean;
  canShare: boolean;
  persona?: string | null;
}) {
  const [proof, setProof] = React.useState(initialProof);
  const [category, setCategory] = React.useState("intake");
  const [caption, setCaption] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = React.useState<number[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [packageBusy, setPackageBusy] = React.useState(false);
  const [shareBusy, setShareBusy] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [shareExpiry, setShareExpiry] = React.useState<
    "1h" | "24h" | "7d" | "30d"
  >("7d");
  const [newShareUrl, setNewShareUrl] = React.useState<string | null>(null);
  const [copyMessage, setCopyMessage] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const uploadClientIdsRef = React.useRef<string[]>([]);
  const uploadOperationKeyRef = React.useRef<string | null>(null);
  const finalizeOperationKeysRef = React.useRef(new Map<string, string>());
  const [uploadAttemptStarted, setUploadAttemptStarted] = React.useState(false);

  const resetUploadAttempt = React.useCallback(() => {
    uploadOperationKeyRef.current = null;
    finalizeOperationKeysRef.current.clear();
    setUploadAttemptStarted(false);
  }, []);
  const comparisonBefore = proof.media.find(
    (media) => media.category === "before" && media.downloadIntent,
  );
  const comparisonAfter = proof.media.find(
    (media) => media.category === "after" && media.downloadIntent,
  );

  const refresh = React.useCallback(async (): Promise<boolean> => {
    const result = await partnerPortalFetch<{ ok: true; proof: PartnerProof }>(
      `jobs/${jobId}/proof`,
    ).catch(() => null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "Proof could not be refreshed.",
      });
      return false;
    }
    setProof(result.data.proof);
    return true;
  }, [jobId]);

  const chooseFiles = (list: FileList | null): void => {
    const selected = Array.from(list ?? []);
    if (selected.length > 10) {
      setFiles([]);
      setUploadProgress([]);
      uploadClientIdsRef.current = [];
      resetUploadAttempt();
      setMessage({
        tone: "error",
        text: "Choose no more than 10 photos in one batch.",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const invalid = selected.find(
      (file) =>
        file.size <= 0 ||
        file.size > MAX_FILE_BYTES ||
        (!ACCEPTED_TYPES.has(file.type) &&
          !(!file.type && ACCEPTED_EXTENSIONS.test(file.name))),
    );
    if (invalid) {
      setFiles([]);
      setUploadProgress([]);
      uploadClientIdsRef.current = [];
      resetUploadAttempt();
      setMessage({
        tone: "error",
        text: `${invalid.name} is not a supported image under 10 MB.`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFiles(selected);
    setUploadProgress(selected.map(() => 0));
    uploadClientIdsRef.current = selected.map(
      () => `photo_${crypto.randomUUID().replace(/-/gu, "")}`,
    );
    resetUploadAttempt();
    setMessage(null);
  };

  const upload = async (): Promise<void> => {
    if (!files.length) {
      setMessage({
        tone: "error",
        text: "Choose at least one photo to upload.",
      });
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setUploadAttemptStarted(true);
    setMessage(null);
    trackPartnerFunnelEvent({
      stage: "upload_started",
      persona,
      surface: "proof_upload",
    });
    const operationKey =
      uploadOperationKeyRef.current ?? createPortalOperationKey("proof-upload");
    uploadOperationKeyRef.current = operationKey;
    const clientFiles = files.map((file, index) => ({
      clientId:
        uploadClientIdsRef.current[index] ??
        `photo_${crypto.randomUUID().replace(/-/gu, "")}`,
      filename: file.name,
      contentType: declaredContentType(file),
      byteLength: file.size,
      checksumSha256: null,
      category,
      caption: caption.trim() || null,
    }));
    const intentResult = await partnerPortalFetch<{
      ok: true;
      intents: UploadIntent[];
    }>(`jobs/${jobId}/proof/upload-intents`, {
      method: "POST",
      headers: { "Idempotency-Key": operationKey },
      body: JSON.stringify({ files: clientFiles }),
    }).catch(() => null);
    if (!intentResult?.ok) {
      trackPartnerFunnelEvent({
        stage: "upload_failed",
        persona,
        surface: "proof_upload",
      });
      setBusy(false);
      setMessage({
        tone: "error",
        text: intentResult?.error.message ?? "The upload could not be started.",
      });
      return;
    }

    const supportReference = portalSupportReferenceFromResponse(
      intentResult.response,
    );
    let finalizedFailure: string | null = null;
    try {
      if (intentResult.data.intents.length !== files.length) {
        throw new Error("upload_intent_count_mismatch");
      }
      for (const [index, intent] of intentResult.data.intents.entries()) {
        if (intent.status === "ready") {
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
        const finalizeOperationKey =
          finalizeOperationKeysRef.current.get(intent.id) ??
          createPortalOperationKey("proof-finalize");
        finalizeOperationKeysRef.current.set(intent.id, finalizeOperationKey);
        const finalized = await partnerPortalFetch<{
          ok: true;
          evidence: PartnerProofMedia;
        }>(`jobs/${jobId}/proof/${intent.id}/finalize`, {
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
        surface: "proof_upload",
      });
      setBusy(false);
      await refresh();
      setMessage({
        tone: "error",
        text:
          finalizedFailure ??
          withPortalSupportReference(
            interrupted
              ? "The photo transfer was interrupted. Ready photos are shown below; retry the unfinished files."
              : "One or more photos did not finish uploading. Ready photos are shown below; retry the others.",
            supportReference,
          ),
      });
      return;
    }

    setFiles([]);
    setUploadProgress([]);
    uploadClientIdsRef.current = [];
    resetUploadAttempt();
    setCaption("");
    if (inputRef.current) inputRef.current.value = "";
    await refresh();
    setBusy(false);
    setMessage({
      tone: "success",
      text: "Photos uploaded and linked to this job.",
    });
    trackPartnerFunnelEvent({
      stage: "upload_completed",
      persona,
      surface: "proof_upload",
    });
  };

  const remove = async (media: PartnerProofMedia): Promise<void> => {
    setDeletingId(media.id);
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true }>(
      `jobs/${jobId}/proof/${media.id}`,
      {
        method: "DELETE",
      },
    ).catch(() => null);
    setDeletingId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The photo was not removed.",
      });
      return;
    }
    setProof((current) => ({
      ...current,
      media: current.media.filter((item) => item.id !== media.id),
    }));
    setMessage({
      tone: "success",
      text: "Photo removed. It remains recoverable under the account retention policy for 30 days.",
    });
  };

  const createPackage = async (): Promise<void> => {
    setPackageBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      package: PartnerProof["packages"][number];
    }>(`jobs/${jobId}/proof/packages`, {
      method: "POST",
      headers: { "Idempotency-Key": createPortalOperationKey("proof-package") },
      body: JSON.stringify({}),
    }).catch(() => null);
    setPackageBusy(false);
    if (!result?.ok) {
      setMessage({
        tone: result?.response.status === 409 ? "warning" : "error",
        text: withPortalSupportReference(
          result?.response.status === 409
            ? "A formal package can be generated after the job is complete and every required photo is ready."
            : (result?.error.message ??
                "The proof package could not be generated."),
          result?.error.correlationId,
        ),
      });
      return;
    }
    await refresh();
    setMessage({
      tone: "success",
      text: `Proof package v${result.data.package.version} generated.`,
    });
  };

  const createShareLink = async (proofPackageId: string): Promise<void> => {
    setShareBusy(true);
    setMessage(null);
    setNewShareUrl(null);
    setCopyMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      shareLink: { id: string; url: string; expiresAt: string };
    }>(`jobs/${jobId}/proof/share-links`, {
      method: "POST",
      headers: { "Idempotency-Key": createPortalOperationKey("proof-share") },
      body: JSON.stringify({ proofPackageId, expiresIn: shareExpiry }),
    }).catch(() => null);
    setShareBusy(false);
    if (!result?.ok) {
      setMessage({
        tone: [404, 501, 503].includes(result?.response.status ?? 503)
          ? "warning"
          : "error",
        text: withPortalSupportReference(
          [404, 501, 503].includes(result?.response.status ?? 503)
            ? "New proof share links are not available through the account service yet. No link was created."
            : (result?.error.message ??
                "The proof share link was not created."),
          result?.error.correlationId,
        ),
      });
      return;
    }
    setNewShareUrl(result.data.shareLink.url);
    await refresh();
    setMessage({
      tone: "success",
      text: "A private, expiring proof link was created. Copy it before leaving this page.",
    });
  };

  const copyShareLink = async (): Promise<void> => {
    if (!newShareUrl) return;
    try {
      await navigator.clipboard.writeText(newShareUrl);
      setCopyMessage("Link copied to the clipboard.");
    } catch {
      setCopyMessage(
        "Copy was blocked. Select the full link and copy it manually.",
      );
    }
  };

  const revokeShareLink = async (shareId: string): Promise<void> => {
    setRevokingId(shareId);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      shareLink: { id: string; revokedAt: string };
    }>(`jobs/${jobId}/proof/share-links/${shareId}`, {
      method: "DELETE",
    }).catch(() => null);
    setRevokingId(null);
    if (!result?.ok) {
      setMessage({
        tone: [404, 501, 503].includes(result?.response.status ?? 503)
          ? "warning"
          : "error",
        text: withPortalSupportReference(
          [404, 501, 503].includes(result?.response.status ?? 503)
            ? "That proof link could not be revoked through the account service. Contact Stonegate if it must be disabled now."
            : (result?.error.message ?? "The proof link was not revoked."),
          result?.error.correlationId,
        ),
      });
      return;
    }
    setProof((current) => ({
      ...current,
      shareLinks: current.shareLinks.map((link) =>
        link.id === shareId
          ? { ...link, revokedAt: result.data.shareLink.revokedAt }
          : link,
      ),
    }));
    setMessage({
      tone: "success",
      text: "Proof link revoked. It no longer opens the shared package.",
    });
  };

  return (
    <div className="space-y-5">
      {message ? (
        <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {proof.requirements.map((requirement) => (
          <div
            key={requirement.category}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-slate-950">
                {humanize(requirement.category)}
              </p>
              {requirement.satisfied ? (
                <CheckCircle2
                  className="h-5 w-5 text-emerald-700"
                  aria-label="Complete"
                />
              ) : (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                  Needed
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {requirement.readyCount} of {requirement.minimumCount} ready
            </p>
          </div>
        ))}
      </div>

      {comparisonBefore && comparisonAfter ? (
        <PartnerBeforeAfterCompare
          before={comparisonBefore}
          after={comparisonAfter}
        />
      ) : null}

      {canUpload ? (
        <section
          aria-labelledby={`proof-upload-${jobId}`}
          className="rounded-2xl border border-primary-200 bg-primary-50/40 p-4 sm:p-5"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-primary-700 shadow-sm">
              <Upload className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h3
                id={`proof-upload-${jobId}`}
                className="font-semibold text-slate-950"
              >
                Add photos to this job
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Choose a category once for this batch. You can add up to 10
                JPEG, PNG, WebP, HEIC, or HEIF photos at a time, up to 10 MB
                each.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label htmlFor={`proof-category-${jobId}`}>
              <span className="text-sm font-semibold text-slate-700">
                Photo category
              </span>
              <select
                id={`proof-category-${jobId}`}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={busy || uploadAttemptStarted}
                className={partnerFieldClass}
              >
                {["intake", "before", "after", "completion", "issue"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {humanize(value)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label htmlFor={`proof-files-${jobId}`}>
              <span className="text-sm font-semibold text-slate-700">
                Photos
              </span>
              <input
                ref={inputRef}
                id={`proof-files-${jobId}`}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                onChange={(event) => chooseFiles(event.target.files)}
                disabled={busy}
                className={`${partnerFieldClass} file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:font-semibold file:text-primary-800`}
              />
            </label>
            <label className="sm:col-span-2" htmlFor={`proof-caption-${jobId}`}>
              <span className="text-sm font-semibold text-slate-700">
                Caption for this batch{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </span>
              <input
                id={`proof-caption-${jobId}`}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                disabled={busy || uploadAttemptStarted}
                maxLength={500}
                className={partnerFieldClass}
                placeholder="Room, unit, condition, issue, or completion note"
              />
            </label>
          </div>
          {files.length ? (
            <div className="mt-3">
              <p className="text-sm text-slate-600">
                {files.length} photo{files.length === 1 ? "" : "s"} selected ·{" "}
                {formatBytes(
                  files.reduce((total, file) => total + file.size, 0),
                )}
              </p>
              <PartnerSelectedPhotoPreviews
                files={files}
                clientIds={uploadClientIdsRef.current}
                progress={uploadProgress}
                label="Selected proof photo previews and upload progress"
              />
            </div>
          ) : null}
          {uploadAttemptStarted && !busy ? (
            <p className="mt-2 text-xs leading-5 text-slate-600">
              Retry keeps this batch’s files, category, and caption unchanged so
              already-uploaded photos can resume safely. Choose files again to
              start a new batch.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void upload()}
            disabled={busy || !files.length}
            className={cn(partnerPrimaryButtonClass, "mt-4 w-full sm:w-auto")}
            data-partner-analytics="proof_photo_upload"
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {busy
              ? "Uploading and processing…"
              : uploadAttemptStarted
                ? "Retry photos"
                : "Upload photos"}
          </button>
        </section>
      ) : (
        <PartnerNotice tone="info">
          Your role can view shared proof but cannot upload or remove job
          photos.
        </PartnerNotice>
      )}

      <section aria-labelledby={`proof-gallery-${jobId}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3
              id={`proof-gallery-${jobId}`}
              className="text-lg font-semibold text-slate-950"
            >
              Photo gallery
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Every image here stays linked to this job and visible only to
              authorized account members.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className={partnerSecondaryButtonClass}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
        {proof.media.length ? (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {proof.media.map((media) => {
              const preview =
                media.downloadIntent?.thumbnailUrl ??
                media.downloadIntent?.displayUrl;
              const original = media.downloadIntent?.originalUrl;
              return (
                <li
                  key={media.id}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
                >
                  <div className="flex aspect-[4/3] items-center justify-center bg-slate-100">
                    {preview ? (
                      // Signed media origins are account-specific and intentionally bypass Next image optimization.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={preview}
                        alt={
                          media.caption?.trim() ||
                          `${humanize(media.category)} job photo`
                        }
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <ImageIcon
                        className="h-10 w-10 text-slate-400"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <div className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-950">
                        {humanize(media.category)}
                      </span>
                      <PartnerStatusBadge status={media.status} />
                    </div>
                    {media.caption ? (
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {media.caption}
                      </p>
                    ) : null}
                    <p className="mt-2 truncate text-xs text-slate-500">
                      {media.filename ?? "Photo"} ·{" "}
                      {formatBytes(media.byteSize)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {original ? (
                        <a
                          href={original}
                          target="_blank"
                          rel="noreferrer"
                          className={partnerSecondaryButtonClass}
                        >
                          Open original
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      ) : null}
                      {canUpload ? (
                        <button
                          type="button"
                          onClick={() => void remove(media)}
                          disabled={deletingId === media.id}
                          className={cn(
                            partnerSecondaryButtonClass,
                            "text-rose-800",
                          )}
                        >
                          {deletingId === media.id ? (
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
        ) : (
          <div className="mt-4">
            <PartnerEmptyState
              title="No photos have been added to this job"
              description={
                canUpload
                  ? "Choose a category above, select the photos, and upload them to keep the job record together."
                  : "Photos will appear here when an authorized account member or Stonegate shares them."
              }
              icon={<Camera className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        )}
      </section>

      <section
        aria-labelledby={`proof-packages-${jobId}`}
        className="rounded-2xl border border-slate-200 p-4 sm:p-5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <FileArchive
              className="mt-0.5 h-5 w-5 text-primary-700"
              aria-hidden="true"
            />
            <div>
              <h3
                id={`proof-packages-${jobId}`}
                className="font-semibold text-slate-950"
              >
                Download or share proof
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Create one fixed completion record, then download it or send an
                expiring link without sharing portal access.
              </p>
            </div>
          </div>
          {canShare ? (
            <button
              type="button"
              onClick={() => void createPackage()}
              disabled={packageBusy}
              className={partnerSecondaryButtonClass}
            >
              {packageBusy ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <FileArchive className="h-4 w-4" aria-hidden="true" />
              )}
              {packageBusy ? "Creating…" : "Create proof package"}
            </button>
          ) : null}
        </div>
        {proof.packages.length ? (
          <ul className="mt-4 space-y-2">
            {proof.packages.map((item) => {
              return (
                <li
                  key={item.id}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">
                        Proof package v{item.version}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Generated{" "}
                        {new Intl.DateTimeFormat("en-US", {
                          dateStyle: "medium",
                        }).format(new Date(item.generatedAt))}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        PDF summary and checksum-verified original photos
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {item.documents.pdfId ? (
                        <PartnerDocumentDownloadButton
                          documentId={item.documents.pdfId}
                          label="Download PDF"
                        />
                      ) : null}
                      {item.documents.originalMediaZipId ? (
                        <PartnerDocumentDownloadButton
                          documentId={item.documents.originalMediaZipId}
                          label="Download original photos (ZIP)"
                        />
                      ) : null}
                      {!item.documents.pdfId &&
                      !item.documents.originalMediaZipId ? (
                        <span
                          className={cn(
                            partnerSecondaryButtonClass,
                            "cursor-not-allowed opacity-60",
                          )}
                          title="This legacy package does not have rendered documents"
                          aria-disabled="true"
                        >
                          Documents unavailable
                        </span>
                      ) : null}
                      {canShare ? (
                        <button
                          type="button"
                          onClick={() => void createShareLink(item.id)}
                          disabled={shareBusy}
                          className={partnerSecondaryButtonClass}
                        >
                          {shareBusy ? (
                            <LoaderCircle
                              className="h-4 w-4 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          ) : (
                            <Link2 className="h-4 w-4" aria-hidden="true" />
                          )}
                          {shareBusy ? "Creating…" : "Create share link"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {canShare ? (
                    <label
                      className="mt-3 block max-w-xs"
                      htmlFor={`share-expiry-${item.id}`}
                    >
                      <span className="text-xs font-semibold text-slate-600">
                        Link expiration
                      </span>
                      <select
                        id={`share-expiry-${item.id}`}
                        value={shareExpiry}
                        onChange={(event) =>
                          setShareExpiry(
                            event.target.value as typeof shareExpiry,
                          )
                        }
                        className={partnerFieldClass}
                      >
                        <option value="1h">1 hour</option>
                        <option value="24h">24 hours</option>
                        <option value="7d">7 days</option>
                        <option value="30d">30 days</option>
                      </select>
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm leading-6 text-slate-600">
            No proof package is ready yet. Create one when the job’s required
            photos are complete.
          </p>
        )}
        {newShareUrl ? (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <label
              htmlFor={`new-proof-share-${jobId}`}
              className="text-sm font-semibold text-emerald-950"
            >
              New private share link
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id={`new-proof-share-${jobId}`}
                readOnly
                value={newShareUrl}
                onFocus={(event) => event.currentTarget.select()}
                className={partnerFieldClass}
              />
              <button
                type="button"
                onClick={() => void copyShareLink()}
                className={partnerSecondaryButtonClass}
              >
                Copy link
              </button>
            </div>
            <p className="mt-2 text-xs text-emerald-900">
              For security, this full URL is shown only when it is created.
            </p>
            {copyMessage ? (
              <p
                className="mt-2 text-sm font-medium text-emerald-950"
                role="status"
                aria-live="polite"
              >
                {copyMessage}
              </p>
            ) : null}
          </div>
        ) : null}
        {proof.shareLinks.length ? (
          <ul className="mt-4 space-y-2">
            {proof.shareLinks.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm"
              >
                <span>
                  <strong>Share record</strong> · expires{" "}
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                  }).format(new Date(link.expiresAt))}
                </span>
                <div className="flex flex-col items-end gap-2">
                  <span className="text-slate-500">
                    {link.revokedAt
                      ? "Revoked"
                      : `${link.accessCount} view${link.accessCount === 1 ? "" : "s"}`}
                  </span>
                  {canShare && !link.revokedAt ? (
                    <details className="rounded-lg border border-rose-200 bg-white p-2 text-left">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-1 font-semibold text-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 [&::-webkit-details-marker]:hidden">
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Revoke link
                      </summary>
                      <p className="mt-2 max-w-64 text-xs leading-5 text-slate-600">
                        Anyone using this link will immediately lose access. You
                        can create a replacement later.
                      </p>
                      <button
                        type="button"
                        onClick={() => void revokeShareLink(link.id)}
                        disabled={revokingId === link.id}
                        className={cn(
                          partnerSecondaryButtonClass,
                          "mt-2 px-3 text-rose-800",
                        )}
                      >
                        {revokingId === link.id ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                        {revokingId === link.id
                          ? "Revoking…"
                          : "Confirm revoke"}
                      </button>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
