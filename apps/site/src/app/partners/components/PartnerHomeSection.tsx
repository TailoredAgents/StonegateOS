"use client";

import { useEffect, useRef, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

/** Keep this account's last successful section visible during a failed refresh. */
export function PartnerHomeSection({
  title,
  error,
  children,
}: {
  title: string;
  error: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const previous = useRef<ReactNode>(error ? null : children);
  useEffect(() => {
    if (!error) previous.current = children;
  }, [children, error]);
  return (
    <section aria-label={title} className="space-y-3">
      {error ? (
        <PartnerNotice tone="warning">
          <p>{error}</p>
          {previous.current ? (
            <p className="mt-1">
              Previously loaded information is shown below.
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => router.refresh())}
            className={`${partnerSecondaryButtonClass} mt-3`}
            aria-label={`Retry ${title.toLowerCase()}`}
          >
            {pending ? "Refreshing…" : "Try again"}
          </button>
        </PartnerNotice>
      ) : null}
      {error ? previous.current : children}
    </section>
  );
}
