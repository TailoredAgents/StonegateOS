"use client";

import Link from "next/link";
import { usePathname, useSelectedLayoutSegments } from "next/navigation";
import { partnerPublicHeaderAction } from "../lib/partner-public-header-action";

const baseClassName =
  "inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 motion-reduce:transition-none";

export function PartnerPublicHeaderAction({
  enabled = true,
}: {
  enabled?: boolean;
}) {
  const pathname = usePathname();
  const segments = useSelectedLayoutSegments();
  if (!enabled || segments.includes("unavailable")) return null;

  const action = partnerPublicHeaderAction(pathname);
  if (!action) return null;

  return (
    <Link
      href={action.href}
      className={`${baseClassName} ${
        action.kind === "sign_in"
          ? "bg-primary-900 text-white hover:bg-slate-800"
          : "border border-slate-300 bg-white text-slate-700 hover:border-accent-200 hover:bg-primary-50 hover:text-primary-900"
      }`}
      data-partner-analytics={action.analyticsKey}
    >
      {action.label}
    </Link>
  );
}
