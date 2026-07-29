"use client";

import { useFormStatus } from "react-dom";

export function MobilePayoutCreateButton({
  hasCurrentDraft,
}: {
  hasCurrentDraft: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-wait disabled:opacity-60"
    >
      {pending
        ? hasCurrentDraft
          ? "Refreshing payout…"
          : "Generating payout…"
        : hasCurrentDraft
          ? "Refresh current payout"
          : "Create payout"}
    </button>
  );
}
