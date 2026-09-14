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
import { usePartnerLiveRefresh } from "../lib/use-partner-live-refresh";
import { usePartnerUnsavedChanges } from "../lib/use-partner-unsaved-changes";
import { parsePortalProof } from "../lib/portal-read-models";

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
  if (
    /\.pdf$/iu.test(file.name) &&
    (!file.type || file.type === "application/pdf")
  )
    return "application/pdf";
  if (file.type) return file.type;
  const filename = file.name.toLowerCase();
  if (/\.jpe?g$/u.test(filename)) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return filename.endsWith(".heic") ? "image/heic" : "image/heif";
}

type PartnerProofWorkspaceProps = {
  accountId?: string;
  jobId: string;
  initialProof: PartnerProof;
  canUpload: boolean;
  canShare: boolean;
  persona?: string | null;
};

export function PartnerProofWorkspace(props: PartnerProofWorkspaceProps) {
  return (
    <PartnerProofWorkspaceSession
      key={`${props.accountId ?? "current"}:${props.jobId}`}
      {...props}
    />
  );
}

function PartnerProofWorkspaceSession({
  jobId,
  initialProof,
  canUpload,
  canShare,
  persona,
}: PartnerProofWorkspaceProps) {
  const [proof, setProof] = React.useState(initialProof);
  const [category, setCategory] = React.useState("intake");
  const [caption, setCaption] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = React.useState<number[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = React.useState<{
    id: string;
    deletedAt: string;
  } | null>(null);
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
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const uploadClientIdsRef = React.useRef<string[]>([]);
  const uploadOperationKeyRef = React.useRef<string | null>(null);
  const finalizeOperationKeysRef = React.useRef(new Map<string, string>());
  const [uploadAttemptStarted, setUploadAttemptStarted] = React.useState(false);
  usePartnerUnsavedChanges(files.length > 0 || busy);

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

  const refresh = React.useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const result = await partnerPortalFetch<{
        ok: true;
        proof: PartnerProof;
      }>(`jobs/${jobId}/proof`, { signal }).catch(() => null);
      if (!result?.ok) {
        if (!signal?.aborted)
          setRefreshError(
            result?.error.message ??
              "Proof could not be refreshed. Your last loaded files are still shown.",
          );
        return false;
      }
      const nextProof = parsePortalProof(result.data);
      if (!nextProof) {
        setRefreshError(
          withPortalSupportReference(
            "Proof could not be refreshed. Your last loaded files are still shown. Please try again.",
            portalSupportReferenceFromResponse(result.response),
          ),
        );
        return false;
      }
      setProof(nextProof);
      setRefreshError(null);
      return true;
    },
    [jobId],
  );
  usePartnerLiveRefresh(jobId, (signal) => refresh(signal), !busy);

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
        (category === "document"
          ? declaredContentType(file) !== "application/pdf"
          : !ACCEPTED_TYPES.has(file.type) &&
            !(!file.type && ACCEPTED_EXTENSIONS.test(file.name))),
    );
    if (invalid) {
      setFiles([]);
      setUploadProgress([]);
      uploadClientIdsRef.current = [];
      resetUploadAttempt();
      setMessage({
        tone: "error",
        text: `${invalid.name} is not a supported ${category === "document" ? "PDF document" : "image"} under 10 MB.`,
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
    if (!canUpload || deletingId) return;
    setDeletingId(media.id);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      deleted: { id: string; deletedAt: string };
    }>(`jobs/${jobId}/proof/${media.id}`, {
      method: "DELETE",
    }).catch(() => null);
    setDeletingId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The file was not removed.",
      });
      return;
    }
    setProof((current) => ({
      ...current,
      media: current.media.filter((item) => item.id !== media.id),
    }));
    setLastDeleted(result.data.deleted);
    await refresh();
    setMessage({
      tone: "success",
      text: "File removed. You can restore it for 30 days.",
    });
  };

  const undoRemove = async (target = lastDeleted) => {
    if (!canUpload || !target || deletingId) return;
    setDeletingId(target.id);
    const result = await partnerPortalFetch(
      `jobs/${jobId}/proof/${target.id}/restore`,
      {
        method: "POST",
        headers: {
          "If-Match": `"${target.deletedAt}"`,
          "Idempotency-Key": `restore:${target.id}:${Date.parse(target.deletedAt)}`,
        },
      },
    ).catch(() => null);
    setDeletingId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The file could not be restored. Contact Stonegate for help.",
      });
      return;
    }
    setLastDeleted(null);
    await refresh();
    setMessage({ tone: "success", text: "File restored." });
  };

  const createPackage = async (): Promise<void> => {
    setPackageBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      status: "preparing";
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
            ? "The completion record is available after service is complete and the required photos are ready."
            : (result?.error.message ??
                "The completion record could not be prepared."),
          result?.error.correlationId,
        ),
      });
      return;
    }
    await refresh();
    setMessage({
      tone: "success",
      text: "Your completion record is being prepared. Download links will appear here when it is ready.",
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
      {refreshError ? (
        <PartnerNotice tone="warning">
          {refreshError}
          <button
            type="button"
            onClick={() => void refresh()}
            className={cn(partnerSecondaryButtonClass, "mt-3")}
            disabled={busy}
          >
            Try again
          </button>
        </PartnerNotice>
      ) : null}
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
                {proof.documentUploadsAvailable
                  ? "Add photos or documents"
                  : "Add photos"}
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Add up to 10 files at a time, 10 MB each. Photos can be JPEG,
                PNG, WebP, HEIC, or HEIF. Each job supports 40 photos.
                {proof.documentUploadsAvailable
                  ? " You can also add up to 10 PDF documents. PDFs stay private while they are checked for safety."
                  : " PDF uploads are not available yet. Contact Stonegate if you need to share a document."}
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label htmlFor={`proof-category-${jobId}`}>
              <span className="text-sm font-semibold text-slate-700">
                File category
              </span>
              <select
                id={`proof-category-${jobId}`}
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setFiles([]);
                  setUploadProgress([]);
                  resetUploadAttempt();
                  if (inputRef.current) inputRef.current.value = "";
                }}
                disabled={busy || uploadAttemptStarted}
                className={partnerFieldClass}
              >
                {[
                  "intake",
                  "before",
                  "after",
                  "completion",
                  "issue",
                  ...(proof.documentUploadsAvailable ? ["document"] : []),
                ].map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`proof-files-${jobId}`}>
              <span className="text-sm font-semibold text-slate-700">
                {category === "document" ? "PDF documents" : "Photos"}
              </span>
              <input
                ref={inputRef}
                id={`proof-files-${jobId}`}
                type="file"
                multiple
                accept={
                  category === "document"
                    ? "application/pdf,.pdf"
                    : "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                }
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
                {files.length} file{files.length === 1 ? "" : "s"} selected ·{" "}
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
                : category === "document"
                  ? "Upload documents"
                  : "Upload photos"}
          </button>
        </section>
      ) : (
        <PartnerNotice tone="info">
          You can view shared proof. Adding or removing files is not available
          right now.
        </PartnerNotice>
      )}

      <section aria-labelledby={`proof-gallery-${jobId}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3
              id={`proof-gallery-${jobId}`}
              className="text-lg font-semibold text-slate-950"
            >
              Photos and documents
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Every file here stays linked to this job and visible only to
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
        {canUpload && lastDeleted ? (
          <div
            className="mt-3 flex flex-wrap items-center gap-3 text-sm"
            role="status"
          >
            <span>File removed. Recovery is available for 30 days.</span>
            <button
              type="button"
              onClick={() => void undoRemove()}
              disabled={Boolean(deletingId)}
              className={partnerSecondaryButtonClass}
            >
              Undo removal
            </button>
          </div>
        ) : null}
        {canUpload && proof.deletedMedia?.length ? (
          <details className="mt-3 rounded-lg border border-slate-200 p-3">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
              Recently removed files
            </summary>
            <ul className="divide-y divide-slate-100">
              {proof.deletedMedia.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span>
                    {file.filename || `${humanize(file.category)} file`}
                    <span className="block text-xs text-slate-600">
                      Recoverable until{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "America/New_York",
                        dateStyle: "medium",
                      }).format(new Date(file.recoverableUntil))}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={Boolean(deletingId)}
                    onClick={() => void undoRemove(file)}
                    className={partnerSecondaryButtonClass}
                  >
                    Restore file
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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
                        onError={(event) => {
                          // Retry a failed signed intent once; periodic refresh renews future intents.
                          if (event.currentTarget.dataset["retried"] === "true")
                            return;
                          event.currentTarget.dataset["retried"] = "true";
                          void refresh();
                        }}
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
                    {media.category === "document" &&
                    media.status === "processing" ? (
                      <p className="mt-2 text-sm text-slate-600" role="status">
                        Safety check in progress. This document is not available
                        yet.
                      </p>
                    ) : null}
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
                          href={`/partners/media/${encodeURIComponent(jobId)}/${encodeURIComponent(media.id)}`}
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
                Completion record
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Your completion record is prepared after the work and required
                photos are complete. Download it or share an expiring link.
              </p>
            </div>
          </div>
          {canShare && proof.packages.length === 0 ? (
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
              {packageBusy ? "Checking…" : "Check for completion record"}
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
                        Completion record · version {item.version}
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
            Your completion record will appear here when the work and required
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
