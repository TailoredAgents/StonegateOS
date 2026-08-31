"use client";

import * as React from "react";
import { CalendarPlus, Copy, Share2 } from "lucide-react";
import {
  createPartnerJobCalendarFile,
  type PartnerJobCalendarInput,
} from "../lib/partner-job-receipt";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

type ReceiptWindow = Readonly<{
  startAt: string;
  endAt: string;
}>;

async function writeClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
  await navigator.clipboard.writeText(value);
}

export function PartnerJobReceiptActions({
  jobId,
  serviceLabel,
  locationLabel,
  arrivalWindow,
  confirmed,
}: {
  jobId: string;
  serviceLabel: string;
  locationLabel: string;
  arrivalWindow: ReceiptWindow | null;
  confirmed: boolean;
}) {
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const cleanPortalUrl = (): string => {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  };

  const copyLink = async (): Promise<void> => {
    try {
      await writeClipboard(cleanPortalUrl());
      setMessage({ tone: "success", text: "Private job link copied." });
    } catch {
      setMessage({
        tone: "error",
        text: "Copy was blocked. Copy the address from your browser instead.",
      });
    }
  };

  const share = async (): Promise<void> => {
    const url = cleanPortalUrl();
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({
          title: `Stonegate job ${jobId.slice(0, 8).toUpperCase()}`,
          text: "Open this private Partner Portal job while signed in.",
          url,
        });
        setMessage({ tone: "success", text: "Job link shared." });
        return;
      }
      await writeClipboard(url);
      setMessage({
        tone: "success",
        text: "Sharing is not available here, so the private job link was copied.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage({
        tone: "error",
        text: "The job link was not shared. No job information was changed.",
      });
    }
  };

  const downloadCalendar = (): void => {
    if (!arrivalWindow) return;
    try {
      const input: PartnerJobCalendarInput = {
        jobId,
        serviceLabel,
        locationLabel,
        startAt: arrivalWindow.startAt,
        endAt: arrivalWindow.endAt,
        portalUrl: cleanPortalUrl(),
        status: confirmed ? "confirmed" : "tentative",
      };
      const file = createPartnerJobCalendarFile(input);
      const objectUrl = URL.createObjectURL(
        new Blob([file.content], { type: "text/calendar;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = file.filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setMessage({
        tone: "success",
        text: confirmed
          ? "Confirmed arrival window downloaded for your calendar."
          : "Tentative requested window downloaded. It is not a confirmed reservation.",
      });
    } catch {
      setMessage({
        tone: "error",
        text: "The calendar file could not be created. The job is unchanged.",
      });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {arrivalWindow ? (
          <button
            type="button"
            onClick={downloadCalendar}
            className={partnerSecondaryButtonClass}
            data-partner-analytics="job_calendar_download"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            Add to calendar
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copyLink()}
          className={partnerSecondaryButtonClass}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy job link
        </button>
        <button
          type="button"
          onClick={() => void share()}
          className={partnerSecondaryButtonClass}
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
          Share link
        </button>
      </div>
      <p className="text-xs leading-5 text-slate-600">
        The job link is private and still requires Partner Portal sign-in.
        {arrivalWindow && !confirmed
          ? " The requested window is marked tentative until Stonegate confirms it."
          : ""}
      </p>
      {message ? (
        <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
      ) : null}
    </div>
  );
}
