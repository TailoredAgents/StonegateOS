"use client";

import * as React from "react";
import { Download, LoaderCircle } from "lucide-react";
import { partnerSecondaryButtonClass } from "./PartnerPortalUi";
import { downloadPartnerServiceReport } from "../lib/portal-report-export";

export function PartnerReportExportButton({ query = "" }: { query?: string }) {
  const [busy, setBusy] = React.useState<"csv" | "pdf" | null>(null);
  const busyRef = React.useRef(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const exportReport = async (format: "csv" | "pdf"): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(format);
    setMessage(null);
    let artifact: Blob;
    try {
      artifact = await downloadPartnerServiceReport({ query, format });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The complete report could not be exported.",
      );
      setBusy(null);
      busyRef.current = false;
      return;
    }
    setBusy(null);
    busyRef.current = false;
    const blobUrl = URL.createObjectURL(artifact);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `stonegate-report.${format}`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  };

  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <div className="flex flex-wrap gap-2">
        {(["csv", "pdf"] as const).map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => void exportReport(format)}
            disabled={busy !== null}
            className={partnerSecondaryButtonClass}
          >
            {busy === format ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {busy === format
              ? `Preparing ${format.toUpperCase()}…`
              : `Download ${format.toUpperCase()}`}
          </button>
        ))}
      </div>
      {message ? (
        <p className="max-w-64 text-xs leading-5 text-amber-800" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
