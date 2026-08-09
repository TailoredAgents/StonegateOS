"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function AccessSessionRefreshButton(): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
      className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:text-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-wait disabled:opacity-70"
    >
      {isPending ? "Refreshing sessions..." : "Refresh sessions"}
    </button>
  );
}
