"use client";

import { useState, type FormEvent, type ReactElement } from "react";
import {
  ConversationExportBodyTimeoutError,
  parseConversationExportError,
  parseReleasedConversationExportReceipt,
  readBoundedExportResponse,
  SITE_CONVERSATION_EXPORT_MAX_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_ERROR_BYTES,
  validateConversationJsonl,
} from "../lib/conversation-export";

const CLIENT_EXPORT_DEADLINE_MS = 70_000;

type ExportStatus =
  | { phase: "idle" }
  | { phase: "loading"; message: string }
  | { phase: "success"; message: string; supportId: string }
  | { phase: "error"; message: string; supportId: string | null };

function filenameFromDisposition(value: string): string {
  const match =
    /^attachment; filename="(stonegate-conversations-\d{4}-\d{2}-\d{2}\.jsonl)"$/u.exec(
      value,
    );
  return match?.[1] ?? "stonegate-conversations.jsonl";
}

function supportSuffix(supportId: string | null): string {
  return supportId ? ` Support ID: ${supportId}.` : "";
}

export function ConversationExportClient(): ReactElement {
  const [days, setDays] = useState("30");
  const [channel, setChannel] = useState("all");
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || status.phase === "loading") return;

    const controller = new AbortController();
    const deadlineAt = Date.now() + CLIENT_EXPORT_DEADLINE_MS;
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      CLIENT_EXPORT_DEADLINE_MS,
    );
    setStatus({
      phase: "loading",
      message:
        "Preparing and validating the complete export. No file is downloaded until every check passes.",
    });

    try {
      const query = new URLSearchParams({ days });
      if (channel !== "all") query.set("channel", channel);
      const response = await fetch(`/api/team/inbox/export?${query}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/x-ndjson, application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmed: true }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBytes = await readBoundedExportResponse(
          response,
          SITE_CONVERSATION_EXPORT_MAX_ERROR_BYTES,
          undefined,
          { deadlineAt, signal: controller.signal },
        );
        const error = parseConversationExportError(
          errorBytes,
          response.headers,
        );
        setStatus({
          phase: "error",
          message:
            error?.message ??
            "The server returned an invalid export error. No file was downloaded.",
          supportId: error?.supportId ?? null,
        });
        return;
      }

      const receipt = parseReleasedConversationExportReceipt(response.headers);
      if (!receipt) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          // The invalid response remains blocked even if cancellation fails.
        }
        setStatus({
          phase: "error",
          message:
            "The server did not provide a valid released audit receipt. No file was downloaded.",
          supportId:
            response.headers.get("x-audit-correlation-id")?.trim() || null,
        });
        return;
      }

      const bytes = await readBoundedExportResponse(
        response,
        SITE_CONVERSATION_EXPORT_MAX_BYTES,
        receipt.byteCount,
        { deadlineAt, signal: controller.signal },
      );
      if (!bytes || !validateConversationJsonl(bytes, receipt)) {
        setStatus({
          phase: "error",
          message:
            "The downloaded response was incomplete or invalid. No file was saved.",
          supportId: receipt.correlationId,
        });
        return;
      }

      const exactBody = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(exactBody).set(bytes);
      const objectUrl = URL.createObjectURL(
        new Blob([exactBody], { type: receipt.contentType }),
      );
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filenameFromDisposition(receipt.contentDisposition);
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);

      setConfirmed(false);
      setStatus({
        phase: "success",
        message: `Released ${receipt.messageCount.toLocaleString()} message${receipt.messageCount === 1 ? "" : "s"} from ${receipt.threadCount.toLocaleString()} conversation${receipt.threadCount === 1 ? "" : "s"} to your browser for download. Receipt ${receipt.receiptId}.`,
        supportId: receipt.correlationId,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        error instanceof ConversationExportBodyTimeoutError;
      setStatus({
        phase: "error",
        message: timedOut
          ? "The export timed out before the complete file was validated. No file was downloaded."
          : "The export could not be completed. No file was downloaded.",
        supportId: null,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  const busy = status.phase === "loading";
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => void handleSubmit(event)}
      aria-busy={busy}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text)]">
          Trailing time range
          <select
            value={days}
            onChange={(event) => setDays(event.target.value)}
            disabled={busy}
            className="min-h-[44px] rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-3 py-2 text-sm text-[color:var(--team-text)] focus:outline-none focus:ring-2 focus:ring-primary-300"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--team-text)]">
          Channel
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            disabled={busy}
            className="min-h-[44px] rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-3 py-2 text-sm text-[color:var(--team-text)] focus:outline-none focus:ring-2 focus:ring-primary-300"
          >
            <option value="all">All channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="dm">Direct message</option>
            <option value="call">Call transcript</option>
            <option value="web">Web chat</option>
          </select>
        </label>
      </div>

      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm leading-5 text-amber-950">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={busy}
          className="mt-0.5 h-5 w-5 shrink-0 accent-primary-600"
        />
        <span>
          I understand that message bodies may contain customer personal data,
          and I will store and delete this file securely.
        </span>
      </label>

      <button
        type="submit"
        disabled={!confirmed || busy}
        className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Preparing secure export…" : "Prepare and download JSONL"}
      </button>

      {status.phase === "loading" ? (
        <p
          className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
          role="status"
          aria-live="polite"
        >
          {status.message}
        </p>
      ) : null}
      {status.phase === "success" ? (
        <p
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          role="status"
          aria-live="polite"
        >
          {status.message}
          {supportSuffix(status.supportId)}
        </p>
      ) : null}
      {status.phase === "error" ? (
        <p
          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          role="alert"
        >
          {status.message}
          {supportSuffix(status.supportId)}
        </p>
      ) : null}
    </form>
  );
}
