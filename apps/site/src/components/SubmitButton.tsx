"use client";

import type { MouseEventHandler } from "react";
import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

export function SubmitButton({
  children,
  label,
  pendingLabel,
  className,
  disabled,
  onClick
}: {
  children?: React.ReactNode;
  label?: string;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const { pending } = useFormStatus();
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPendingRef = useRef(false);

  useEffect(() => {
    const wasPending = lastPendingRef.current;
    lastPendingRef.current = pending;

    if (wasPending && !pending) {
      try {
        router.refresh();
      } catch {
        // ignore
      }
    }

    if (!pending) {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      refreshTimerRef.current = null;
      reloadTimerRef.current = null;
      return;
    }

    if (!refreshTimerRef.current) {
      refreshTimerRef.current = setTimeout(() => {
        try {
          router.refresh();
        } catch {
          // ignore
        }
      }, 25_000);
    }

    if (!reloadTimerRef.current) {
      reloadTimerRef.current = setTimeout(() => {
        try {
          window.location.reload();
        } catch {
          // ignore
        }
      }, 45_000);
    }
  }, [pending, router]);

  const isDisabled = pending || disabled;
  return (
    <button type="submit" className={className} disabled={isDisabled} onClick={onClick}>
      {pending ? pendingLabel ?? "Saving..." : children ?? label ?? "Save"}
    </button>
  );
}
