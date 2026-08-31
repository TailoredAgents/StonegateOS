"use client";

import * as React from "react";
import { Download, LoaderCircle } from "lucide-react";
import { cn } from "@myst-os/ui";
import { partnerPortalFetch } from "../lib/portal-v2";
import { partnerSecondaryButtonClass } from "./PartnerPortalUi";

type DownloadIntentPayload = {
  ok: true;
  download?: { url?: string };
  downloadIntent?: { url?: string };
  url?: string;
};

export function PartnerDocumentDownloadButton({
  documentId,
  label = "Download",
  className,
}: {
  documentId: string;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const requestDownload = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await partnerPortalFetch<DownloadIntentPayload>(
      `documents/${documentId}/download-intent`,
      { method: "POST" },
    ).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(
        [404, 409, 501, 503].includes(result?.response.status ?? 503)
          ? "Secure downloads are not available yet."
          : result?.error.message ?? "This document could not be downloaded.",
      );
      return;
    }
    const url = result.data.download?.url ?? result.data.downloadIntent?.url ?? result.data.url;
    if (!url) {
      setError("The document service did not return a download link.");
      return;
    }
    let target: URL;
    try {
      target = new URL(url, window.location.origin);
    } catch {
      setError("The document service returned an invalid download link.");
      return;
    }
    const localHttp =
      target.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
    if (target.protocol !== "https:" && !localHttp) {
      setError("The document service returned an unsafe download link.");
      return;
    }
    window.location.assign(target.href);
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void requestDownload()}
        disabled={busy}
        className={cn(partnerSecondaryButtonClass, className)}
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? "Preparing…" : label}
      </button>
      {error ? (
        <span className="max-w-56 text-xs leading-5 text-amber-800" role="status">
          {error}
        </span>
      ) : null}
    </span>
  );
}
