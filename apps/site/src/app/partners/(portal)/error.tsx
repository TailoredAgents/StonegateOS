"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { partnerPrimaryButtonClass } from "@/app/partners/components/PartnerPortalUi";

export default function PartnerPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm sm:p-8"
      role="alert"
    >
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-700 ring-1 ring-rose-200">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-4 text-xl font-semibold text-slate-950">Something went wrong</h1>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-600">
        Your account and jobs are unchanged. Try loading this view again.
      </p>
      <button type="button" onClick={reset} className={`${partnerPrimaryButtonClass} mt-5`}>
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        Try again
      </button>
      {error.digest ? <p className="mt-4 text-xs text-slate-400">Reference: {error.digest}</p> : null}
    </section>
  );
}
