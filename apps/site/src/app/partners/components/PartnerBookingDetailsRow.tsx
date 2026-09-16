"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

export function PartnerBookingDetailsRow({
  title,
  summary,
  children,
  reveal = false,
  validationErrors,
  id,
}: {
  title: string;
  summary: string;
  children: React.ReactNode;
  reveal?: boolean;
  validationErrors?: Record<string, string>;
  id?: string;
}) {
  // Keep native disclosure state: delayed toggle events in WebKit can otherwise
  // overwrite a validation-driven open when nested sections were just closed.
  const detailsRef = React.useRef<HTMLDetailsElement>(null);

  React.useEffect(() => {
    // Missing information and validation errors may reveal a section. Editing
    // a field must never close the section and move focus away from the user.
    if (reveal && detailsRef.current) detailsRef.current.open = true;
  }, [reveal, validationErrors]);

  return (
    <details
      ref={detailsRef}
      id={id}
      tabIndex={id ? -1 : undefined}
      className="group/details border-b border-slate-200 last:border-b-0"
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 rounded-lg py-3 text-left sm:min-h-14 sm:py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span className="grid min-w-0 flex-1 gap-0.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-4">
          <span className="block text-sm font-semibold text-slate-900">
            {title}
          </span>
          <span className="block truncate text-sm font-normal text-slate-500">
            {summary}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/details:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="pb-5 pt-2">{children}</div>
    </details>
  );
}
