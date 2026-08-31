"use client";

import * as React from "react";
import { ImageIcon } from "lucide-react";

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(value / 1024))} KB`;
}

export function PartnerSelectedPhotoPreviews({
  files,
  clientIds,
  progress,
  label,
}: {
  files: readonly File[];
  clientIds: readonly string[];
  progress: readonly number[];
  label: string;
}) {
  const [previewUrls, setPreviewUrls] = React.useState<string[]>([]);
  const [failedPreviews, setFailedPreviews] = React.useState<Set<number>>(
    () => new Set(),
  );

  React.useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    setFailedPreviews(new Set());
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [files]);

  if (!files.length) return null;
  return (
    <ul className="mt-3 grid gap-3 sm:grid-cols-2" aria-label={label}>
      {files.map((file, index) => {
        const percent = Math.min(
          100,
          Math.max(0, Math.round(progress[index] ?? 0)),
        );
        const previewUrl = previewUrls[index];
        const previewFailed = failedPreviews.has(index);
        return (
          <li
            key={`${clientIds[index] ?? file.name}-${file.lastModified}`}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            <div className="flex aspect-[4/3] items-center justify-center bg-slate-100">
              {previewUrl && !previewFailed ? (
                // Local object URLs intentionally bypass image optimization.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={`Selected photo: ${file.name}`}
                  className="h-full w-full object-cover"
                  onError={() =>
                    setFailedPreviews((current) => {
                      const next = new Set(current);
                      next.add(index);
                      return next;
                    })
                  }
                />
              ) : (
                <div className="px-4 text-center text-slate-500">
                  <ImageIcon className="mx-auto h-8 w-8" aria-hidden="true" />
                  <p className="mt-2 text-xs leading-5">
                    Preview unavailable; the file will still be validated before
                    it is attached.
                  </p>
                </div>
              )}
            </div>
            <div className="p-3">
              <div className="flex items-start justify-between gap-3 text-xs text-slate-600">
                <span className="min-w-0 truncate font-semibold text-slate-800">
                  {file.name}
                </span>
                <span className="shrink-0">{percent}%</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {formatBytes(file.size)}
              </p>
              <progress
                className="mt-2 h-2 w-full accent-primary-700"
                max={100}
                value={percent}
                aria-label={`${file.name} upload progress`}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
