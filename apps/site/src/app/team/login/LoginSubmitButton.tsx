"use client";

import { useFormStatus } from "react-dom";

export function LoginSubmitButton({
  label,
  pendingLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  variant: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  const tone =
    variant === "primary"
      ? "bg-primary-600 text-white shadow-lg shadow-primary-200/50 hover:bg-primary-700"
      : "border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-primary-400 hover:text-primary-800";

  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      aria-busy={pending}
      className={`min-h-11 w-full rounded-2xl px-4 py-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60 ${tone}`}
    >
      <span aria-live="polite">{pending ? pendingLabel : label}</span>
    </button>
  );
}
