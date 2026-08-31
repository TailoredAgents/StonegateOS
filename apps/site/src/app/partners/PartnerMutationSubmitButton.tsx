"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export function PartnerMutationSubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: ReactNode;
  pendingLabel: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      aria-busy={pending}
      className={className}
    >
      <span className="contents" aria-live="polite" aria-atomic="true">
        {pending ? pendingLabel : children}
      </span>
    </button>
  );
}
