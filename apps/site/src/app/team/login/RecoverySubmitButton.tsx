"use client";

import { useFormStatus } from "react-dom";

export function RecoverySubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="min-h-11 rounded-2xl border border-amber-300 bg-white px-4 py-3 font-semibold text-amber-950 shadow-sm hover:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Restoring access…" : "Restore temporary access"}
    </button>
  );
}
