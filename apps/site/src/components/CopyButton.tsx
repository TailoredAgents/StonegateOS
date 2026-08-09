"use client";

import { useState } from "react";

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // The browser may deny clipboard access; leave the button retryable.
    }
  }

  return (
    <button
      type="button"
      className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-50"
      onClick={() => {
        void copyToClipboard();
      }}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
