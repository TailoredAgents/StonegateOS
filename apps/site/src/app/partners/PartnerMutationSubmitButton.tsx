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
      className={className}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
