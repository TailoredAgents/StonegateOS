"use client";

import * as React from "react";
import { Download, LoaderCircle } from "lucide-react";
import { partnerSecondaryButtonClass } from "./PartnerPortalUi";

export function PartnerReportExportButton() {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const exportReport = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/partners/portal/reports?format=csv", {
      cache: "no-store",
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setMessage(
        response?.status === 403
          ? "Your role does not include report export."
          : [404, 409, 501, 503].includes(response?.status ?? 503)
            ? "Report export is not available yet."
            : "The report could not be exported.",
      );
      return;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/csv")) {
      setMessage("The report service did not return a CSV file.");
      return;
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = "partner-reports.csv";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  };

  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <button
        type="button"
        onClick={() => void exportReport()}
        disabled={busy}
        className={partnerSecondaryButtonClass}
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? "Preparing export…" : "Export CSV"}
      </button>
      {message ? (
        <p className="max-w-64 text-xs leading-5 text-amber-800" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
