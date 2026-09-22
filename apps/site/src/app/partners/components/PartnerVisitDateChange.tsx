"use client";

import { useId, useRef, useState } from "react";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerVisitDateChange({
  jobId,
  visitId,
  etag,
  timezone,
}: {
  jobId: string;
  visitId: string;
  etag: string;
  timezone: string;
}) {
  const id = useId();
  const [date, setDate] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("anytime");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const operation = useRef<{ body: string; key: string } | null>(null);
  return (
    <details className="mt-3 border-t border-slate-200 pt-2">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-primary-800">
        Request a different date
      </summary>
      {saved ? (
        <p role="status" className="text-sm text-emerald-800">
          Date change requested for this visit. Its confirmed schedule stays in
          place until Stonegate confirms the change.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (busy) return;
              const body = JSON.stringify({
                preferredWindows: [{ localDate: date, timeOfDay, timezone }],
              });
              if (operation.current?.body !== body)
                operation.current = {
                  body,
                  key: createPortalOperationKey("visit-date-change"),
                };
              setBusy(true);
              setMessage("");
              const result = await partnerPortalFetch<{
                ok: true;
                reschedule: {
                  mode: string;
                  jobId: string;
                  visitId: string;
                  requestId: string;
                  consequence: { existingScheduleRemainsInPlace: boolean };
                };
              }>(
                `jobs/${encodeURIComponent(jobId)}/visits/${encodeURIComponent(visitId)}/reschedule`,
                {
                  method: "POST",
                  headers: {
                    "If-Match": etag,
                    "Idempotency-Key": operation.current.key,
                  },
                  body,
                },
              ).catch(() => null);
              setBusy(false);
              const receipt = result?.ok ? result.data.reschedule : null;
              if (
                receipt?.mode === "review" &&
                receipt.jobId === jobId &&
                receipt.visitId === visitId &&
                typeof receipt.requestId === "string" &&
                receipt.requestId.trim().length > 0 &&
                receipt.consequence?.existingScheduleRemainsInPlace === true
              )
                setSaved(true);
              else
                setMessage(
                  result && !result.ok
                    ? result.error.message
                    : "The request could not be confirmed. Retry the same date or refresh the job to check its status.",
                );
            })();
          }}
        >
          <p className="text-sm text-slate-600">
            This requests a change to this visit only. Your confirmed dates stay
            in place until Stonegate responds.
          </p>
          <label htmlFor={`${id}-date`} className="block text-sm font-medium">
            Preferred date
          </label>
          <input
            id={`${id}-date`}
            type="date"
            required
            disabled={busy}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={partnerFieldClass}
          />
          <label htmlFor={`${id}-time`} className="block text-sm font-medium">
            Preferred time
          </label>
          <select
            id={`${id}-time`}
            disabled={busy}
            value={timeOfDay}
            onChange={(event) => setTimeOfDay(event.target.value)}
            className={partnerFieldClass}
          >
            <option value="anytime">Any time</option>
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
          </select>
          <p className="text-xs text-slate-500">
            Times use {timezone.replaceAll("_", " ")}.
          </p>
          {message ? (
            <p role="alert" className="text-sm text-red-700">
              {message}
            </p>
          ) : null}
          <button disabled={busy} className={partnerPrimaryButtonClass}>
            {busy ? "Sending request…" : "Request date change"}
          </button>
        </form>
      )}
    </details>
  );
}
