"use client";

import React, { useEffect, useMemo, useState } from "react";

function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

function isVideoContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("video/");
}

export function InboxMediaGallery({ messageId, count }: { messageId: string; count: number }) {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const mediaUrls = useMemo(() => {
    return Array.from({ length: safeCount }, (_, index) => {
      return `/api/team/inbox/media/${encodeURIComponent(messageId)}/${index}`;
    });
  }, [messageId, safeCount]);

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const activeIndex = openIndex === null ? null : clampIndex(openIndex, safeCount);
  const [contentTypes, setContentTypes] = useState<Record<number, string>>({});
  const activeContentType = activeIndex !== null ? contentTypes[activeIndex] ?? null : null;
  const activeIsVideo = isVideoContentType(activeContentType);

  useEffect(() => {
    if (safeCount <= 0) return;
    let cancelled = false;

    async function loadTypes() {
      const entries = await Promise.all(
        mediaUrls.map(async (href, index) => {
          try {
            const response = await fetch(href, { method: "HEAD" });
            if (!response.ok) return [index, "" as const] as const;
            return [index, response.headers.get("content-type") ?? ""] as const;
          } catch {
            return [index, "" as const] as const;
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

    loadTypes();
    return () => {
      cancelled = true;
    };
  }, [mediaUrls, safeCount]);

  useEffect(() => {
    if (activeIndex === null) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenIndex(null);
        return;
      }
      if (event.key === "ArrowLeft") {
        setOpenIndex((value) => (typeof value === "number" ? value - 1 : 0));
        return;
      }
      if (event.key === "ArrowRight") {
        setOpenIndex((value) => (typeof value === "number" ? value + 1 : 0));
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeIndex]);

  if (safeCount <= 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {mediaUrls.map((href, index) => {
          const type = contentTypes[index] ?? null;
          const isVideo = isVideoContentType(type);
          return (
            <button
              key={`${messageId}-${index}`}
              type="button"
              onClick={() => setOpenIndex(index)}
              className="group relative block overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              title={isVideo ? "View video" : "View photo"}
            >
              {isVideo ? (
                <div className="flex h-28 w-full items-center justify-center bg-slate-900 text-white">
                  <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">
                    <span className="text-sm">▶</span> Video
                  </div>
                </div>
              ) : (
                <img
                  src={href}
                  alt={`Attachment ${index + 1}`}
                  loading="lazy"
                  className="h-28 w-full object-cover transition group-hover:opacity-90"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
        {mediaUrls.map((href, index) => (
          <a
            key={`${messageId}-download-${index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-slate-200 px-3 py-1 font-medium text-slate-600 hover:border-primary-300 hover:text-primary-700"
          >
            Open {index + 1}
          </a>
        ))}
      </div>

      {activeIndex !== null ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Photo viewer"
          onClick={() => setOpenIndex(null)}
        >
          <div
            className="relative w-full max-w-4xl rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 px-1 pb-2 text-xs text-slate-600">
              <span>
                Attachment {activeIndex + 1} of {safeCount}
              </span>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800"
                onClick={() => setOpenIndex(null)}
              >
                Close
              </button>
            </div>

            <div className="relative overflow-hidden rounded-xl bg-slate-50">
              {activeIsVideo ? (
                <video
                  controls
                  playsInline
                  className="mx-auto max-h-[75vh] w-auto max-w-full"
                  src={mediaUrls[activeIndex]}
                />
              ) : (
                <img
                  src={mediaUrls[activeIndex]}
                  alt={`Attachment ${activeIndex + 1}`}
                  className="mx-auto max-h-[75vh] w-auto max-w-full object-contain"
                />
              )}
            </div>

            {safeCount > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                  onClick={() => setOpenIndex((value) => (typeof value === "number" ? value - 1 : 0))}
                >
                  Prev
                </button>
                <a
                  href={mediaUrls[activeIndex]}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                >
                  Open
                </a>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                  onClick={() => setOpenIndex((value) => (typeof value === "number" ? value + 1 : 0))}
                >
                  Next
                </button>
              </div>
            ) : (
              <div className="mt-3 flex justify-end">
                <a
                  href={mediaUrls[activeIndex]}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                >
                  Open
                </a>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
