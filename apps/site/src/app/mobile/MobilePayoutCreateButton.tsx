"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type PayoutRefreshPayload = {
  ok?: boolean;
  payoutRunId?: string;
  reportGeneratedAt?: string | null;
  error?: string;
  message?: string;
};

function formatReadyAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function MobilePayoutCreateButton({
  hasCurrentDraft,
}: {
  hasCurrentDraft: boolean;
}) {
  const router = useRouter();
  const inFlightRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [result, setResult] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [pending]);

  const refreshPayout = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    setElapsedSeconds(0);
    setResult(null);
    idempotencyKeyRef.current ??= `commissions:mobile-refresh:${globalThis.crypto.randomUUID()}`;

    try {
      const response = await fetch("/api/mobile/owner/payout-runs/refresh", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
      });
      const payload = (await response
        .json()
        .catch(() => null)) as PayoutRefreshPayload | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.message?.trim() ||
            payload?.error?.trim() ||
            "The payout could not be refreshed.",
        );
      }

      const readyAt = formatReadyAt(payload.reportGeneratedAt);
      setResult({
        tone: "success",
        message: readyAt
          ? `Payout ready. Report refreshed at ${readyAt}.`
          : "Payout ready. The latest totals and report are available.",
      });
      idempotencyKeyRef.current = null;
      router.refresh();
    } catch (error) {
      setResult({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The payout could not be refreshed.",
      });
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void refreshPayout()}
        className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-wait disabled:opacity-60"
      >
        {pending
          ? hasCurrentDraft
            ? `Refreshing… ${elapsedSeconds}s`
            : `Generating… ${elapsedSeconds}s`
          : hasCurrentDraft
            ? "Refresh current payout"
            : "Create payout"}
      </button>
      {pending ? (
        <p
          className="mt-2 max-w-48 text-xs leading-5 text-cyan-100"
          role="status"
          aria-live="polite"
        >
          Recalculating completed jobs and rebuilding the report. Keep this
          screen open.
        </p>
      ) : result ? (
        <p
          className={`mt-2 max-w-48 text-xs leading-5 ${
            result.tone === "success" ? "text-emerald-200" : "text-rose-200"
          }`}
          role={result.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
