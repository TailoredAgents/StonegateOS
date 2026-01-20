"use client";

import { useFormState } from "react-dom";
import { rescheduleAction, type RescheduleState } from "./actions";

export function RescheduleForm({
  appointmentId,
  token,
  next
}: {
  appointmentId: string;
  token: string;
  next?: string;
}) {
  const [state, formAction] = useFormState<RescheduleState, FormData>(rescheduleAction, {});

  return (
    <form action={formAction} className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-soft">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="token" value={token} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="space-y-2">
        <label htmlFor="preferredDate" className="block text-sm font-medium text-neutral-700">
          Pick a date
        </label>
        <input
          id="preferredDate"
          name="preferredDate"
          type="date"
          required
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="startTime" className="block text-sm font-medium text-neutral-700">
          Time
        </label>
        <input
          id="startTime"
          name="startTime"
          type="time"
          required
          step={900}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
        />
        <p className="text-xs text-neutral-500">Times are in Eastern time.</p>
      </div>

      {state?.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
      {state?.ok ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Rescheduled. We&apos;ll see you{" "}
          {state.startAt
            ? new Date(state.startAt).toLocaleString("en-US", {
                timeZone: "America/New_York",
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit"
              })
            : state.preferredDate ?? "soon"}
          .
        </div>
      ) : null}

      <button
        type="submit"
        className="inline-flex w-full items-center justify-center rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-primary-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
      >
        Confirm new time
      </button>
    </form>
  );
}

