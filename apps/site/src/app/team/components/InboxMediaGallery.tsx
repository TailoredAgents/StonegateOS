"use client";

import Image from "next/image";
import React, { useEffect, useMemo, useRef, useState } from "react";

const MAX_CONCURRENT_TYPE_PROBES = 3;

type ProbeStatus = "pending" | "ready" | "failed";

function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

function isVideoContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("video/");
}

export function InboxMediaGallery({
  messageId,
  count,
}: {
  messageId: string;
  count: number;
}) {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const mediaUrls = useMemo(() => {
    return Array.from({ length: safeCount }, (_, index) => {
      return `/api/team/inbox/media/${encodeURIComponent(messageId)}/${index}`;
    });
  }, [messageId, safeCount]);

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const activeIndex =
    openIndex === null ? null : clampIndex(openIndex, safeCount);
  const activeMediaUrl =
    activeIndex === null ? null : (mediaUrls[activeIndex] ?? null);
  const [contentTypes, setContentTypes] = useState<Record<number, string>>({});
  const [probeStatuses, setProbeStatuses] = useState<
    Record<number, ProbeStatus>
  >({});
  const [shouldProbe, setShouldProbe] = useState(false);
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const activeContentType =
    activeIndex !== null ? (contentTypes[activeIndex] ?? null) : null;
  const activeIsVideo = isVideoContentType(activeContentType);
  const activeProbeStatus =
    activeIndex !== null
      ? (probeStatuses[activeIndex] ?? "pending")
      : "pending";

  useEffect(() => {
    setContentTypes({});
    setProbeStatuses({});
    setOpenIndex(null);
    setShouldProbe(false);
  }, [messageId, safeCount]);

  useEffect(() => {
    if (safeCount <= 0) return;
    const gallery = galleryRef.current;
    if (!gallery || typeof IntersectionObserver === "undefined") {
      setShouldProbe(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldProbe(true);
        observer.disconnect();
      },
      { rootMargin: "160px" },
    );
    observer.observe(gallery);
    return () => observer.disconnect();
  }, [messageId, safeCount]);

  useEffect(() => {
    if (!shouldProbe || safeCount <= 0) return;
    let cancelled = false;
    let nextIndex = 0;
    const controller = new AbortController();

    async function loadTypes(): Promise<void> {
      const nextTypes: Record<number, string> = {};
      const nextStatuses: Record<number, ProbeStatus> = {};
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= mediaUrls.length) return;
          const href = mediaUrls[index];
          if (!href) return;
          try {
            const response = await fetch(href, {
              method: "HEAD",
              signal: controller.signal,
            });
            const contentType = response.ok
              ? (response.headers.get("content-type") ?? "")
              : "";
            if (contentType) {
              nextTypes[index] = contentType;
              nextStatuses[index] = "ready";
            } else {
              nextStatuses[index] = "failed";
            }
          } catch {
            if (!controller.signal.aborted) nextStatuses[index] = "failed";
          }
        }
      };
      const workerCount = Math.min(
        MAX_CONCURRENT_TYPE_PROBES,
        mediaUrls.length,
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (cancelled) return;
      setContentTypes(nextTypes);
      setProbeStatuses(nextStatuses);
    }

    void loadTypes();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mediaUrls, safeCount, shouldProbe]);

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
    <div ref={galleryRef} className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {mediaUrls.map((href, index) => {
          const type = contentTypes[index] ?? null;
          const isVideo = isVideoContentType(type);
          const probeStatus = probeStatuses[index] ?? "pending";
          return (
            <button
              key={`${messageId}-${index}`}
              type="button"
              onClick={() => setOpenIndex(index)}
              className="group relative block overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              title={
                probeStatus === "failed"
                  ? "Open attachment"
                  : isVideo
                    ? "View video"
                    : "View photo"
              }
            >
              {probeStatus === "pending" ? (
                <div className="flex h-28 w-full items-center justify-center bg-slate-100 px-3 text-center text-xs font-medium text-slate-500">
                  Loading preview…
                </div>
              ) : probeStatus === "failed" ? (
                <div className="flex h-28 w-full items-center justify-center bg-amber-50 px-3 text-center text-xs font-semibold text-amber-800">
                  Preview unavailable · Attachment {index + 1}
                </div>
              ) : isVideo ? (
                <div className="flex h-28 w-full items-center justify-center bg-slate-900 text-white">
                  <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">
                    <span className="text-sm">▶</span> Video
                  </div>
                </div>
              ) : (
                <Image
                  src={href}
                  alt={`Attachment ${index + 1}`}
                  fill
                  sizes="(min-width: 640px) 33vw, 50vw"
                  unoptimized
                  className="object-cover transition group-hover:opacity-90"
                />
              )}
            </button>
          );
        })}
      </div>

      {Object.values(probeStatuses).some((status) => status === "failed") ? (
        <p className="text-[11px] font-medium text-amber-700" role="status">
          One or more previews could not be loaded. Use Open to retry the
          attachment directly.
        </p>
      ) : null}

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

      {activeIndex !== null && activeMediaUrl ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Attachment viewer"
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
              {activeProbeStatus === "pending" ? (
                <div className="flex min-h-64 items-center justify-center px-4 text-sm font-medium text-slate-600">
                  Loading attachment preview…
                </div>
              ) : activeProbeStatus === "failed" ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-slate-600">
                  <p>
                    The preview is unavailable, but the original attachment may
                    still open.
                  </p>
                  <a
                    href={activeMediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-slate-200 px-4 py-2 font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                  >
                    Open attachment
                  </a>
                </div>
              ) : activeIsVideo ? (
                <video
                  controls
                  playsInline
                  className="mx-auto max-h-[75vh] w-auto max-w-full"
                  src={activeMediaUrl}
                />
              ) : (
                <Image
                  src={activeMediaUrl}
                  alt={`Attachment ${activeIndex + 1}`}
                  width={1600}
                  height={1200}
                  sizes="100vw"
                  unoptimized
                  className="mx-auto h-auto max-h-[75vh] w-auto max-w-full object-contain"
                />
              )}
            </div>

            {safeCount > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                  onClick={() =>
                    setOpenIndex((value) =>
                      typeof value === "number" ? value - 1 : 0,
                    )
                  }
                >
                  Prev
                </button>
                <a
                  href={activeMediaUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                >
                  Open
                </a>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700"
                  onClick={() =>
                    setOpenIndex((value) =>
                      typeof value === "number" ? value + 1 : 0,
                    )
                  }
                >
                  Next
                </button>
              </div>
            ) : (
              <div className="mt-3 flex justify-end">
                <a
                  href={activeMediaUrl}
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
