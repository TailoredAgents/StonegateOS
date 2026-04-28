"use client";

import { useEffect, useMemo, useState } from "react";

type MobileInboxMediaGalleryProps = {
  messageId: string;
  count: number;
  compact?: boolean;
};

function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

function isVideoContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType?.toLowerCase().startsWith("video/"));
}

export function MobileInboxMediaGallery({ messageId, count, compact = false }: MobileInboxMediaGalleryProps) {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const mediaUrls = useMemo(
    () => Array.from({ length: safeCount }, (_, index) => `/api/team/inbox/media/${encodeURIComponent(messageId)}/${index}`),
    [messageId, safeCount]
  );
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const activeIndex = openIndex === null ? null : clampIndex(openIndex, safeCount);
  const [contentTypes, setContentTypes] = useState<Record<number, string>>({});
  const activeContentType = activeIndex !== null ? contentTypes[activeIndex] ?? null : null;
  const activeIsVideo = isVideoContentType(activeContentType);

  useEffect(() => {
    if (safeCount <= 0) return;
    let cancelled = false;

    async function loadContentTypes() {
      const entries = await Promise.all(
        mediaUrls.map(async (href, index) => {
          try {
            const response = await fetch(href, { method: "HEAD" });
            if (!response.ok) return [index, ""] as const;
            return [index, response.headers.get("content-type") ?? ""] as const;
          } catch {
            return [index, ""] as const;
          }
        })
      );
      if (cancelled) return;
      const next: Record<number, string> = {};
      for (const [index, contentType] of entries) {
        if (contentType) next[index] = contentType;
      }
      setContentTypes(next);
    }

    void loadContentTypes();
    return () => {
      cancelled = true;
    };
  }, [mediaUrls, safeCount]);

  useEffect(() => {
    if (activeIndex === null) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenIndex(null);
      if (event.key === "ArrowLeft") setOpenIndex((value) => (typeof value === "number" ? value - 1 : 0));
      if (event.key === "ArrowRight") setOpenIndex((value) => (typeof value === "number" ? value + 1 : 0));
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeIndex]);

  if (safeCount <= 0) return null;

  return (
    <div className={compact ? "flex gap-2 overflow-x-auto pb-1" : "mt-2 grid grid-cols-2 gap-2"}>
      {mediaUrls.map((href, index) => {
        const isVideo = isVideoContentType(contentTypes[index]);
        return (
          <button
            key={`${messageId}-${index}`}
            type="button"
            onClick={() => setOpenIndex(index)}
            className={`relative shrink-0 overflow-hidden rounded-md border border-white/10 bg-slate-950 ${
              compact ? "h-20 w-20" : "h-32 w-full"
            }`}
            title={isVideo ? "View video" : "View photo"}
          >
            {isVideo ? (
              <div className="flex h-full w-full items-center justify-center bg-slate-950 text-xs font-semibold text-cyan-100">
                Video
              </div>
            ) : (
              <img src={href} alt={`Attachment ${index + 1}`} loading="lazy" className="h-full w-full object-cover" />
            )}
          </button>
        );
      })}

      {activeIndex !== null ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-3"
          role="dialog"
          aria-modal="true"
          aria-label="Thread media viewer"
          onClick={() => setOpenIndex(null)}
        >
          <div className="w-full max-w-lg rounded-lg border border-white/10 bg-slate-950 p-3" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-300">
              <span>
                Attachment {activeIndex + 1} of {safeCount}
              </span>
              <button type="button" className="rounded-md border border-white/10 px-3 py-2 font-semibold text-white" onClick={() => setOpenIndex(null)}>
                Close
              </button>
            </div>
            <div className="overflow-hidden rounded-md bg-slate-900">
              {activeIsVideo ? (
                <video controls playsInline src={mediaUrls[activeIndex]} className="mx-auto max-h-[75dvh] w-auto max-w-full" />
              ) : (
                <img src={mediaUrls[activeIndex]} alt={`Attachment ${activeIndex + 1}`} className="mx-auto max-h-[75dvh] w-auto max-w-full object-contain" />
              )}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              {safeCount > 1 ? (
                <button type="button" className="rounded-md border border-white/10 px-4 py-2 text-sm font-semibold text-white" onClick={() => setOpenIndex((value) => (typeof value === "number" ? value - 1 : 0))}>
                  Prev
                </button>
              ) : <span />}
              <a href={mediaUrls[activeIndex]} target="_blank" rel="noreferrer" className="rounded-md bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950">
                Open
              </a>
              {safeCount > 1 ? (
                <button type="button" className="rounded-md border border-white/10 px-4 py-2 text-sm font-semibold text-white" onClick={() => setOpenIndex((value) => (typeof value === "number" ? value + 1 : 0))}>
                  Next
                </button>
              ) : <span />}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
