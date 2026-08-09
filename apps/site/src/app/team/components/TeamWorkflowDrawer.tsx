"use client";

import React from "react";
import { teamButtonClass } from "./team-ui";

type TeamWorkflowDrawerProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
  onClose: () => void;
};

/**
 * Modal workflow drawer for focused CRM tasks.
 *
 * The native modal dialog supplies an inert page boundary and browser focus
 * containment. This wrapper adds deterministic initial focus, Escape/backdrop
 * handling, scroll locking, accessible naming, and focus restoration.
 */
export function TeamWorkflowDrawer({
  title,
  description,
  children,
  onClose,
}: TeamWorkflowDrawerProps): React.ReactElement {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const onCloseRef = React.useRef(onClose);
  const titleId = React.useId();
  const descriptionId = React.useId();

  onCloseRef.current = onClose;

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    if (!dialog.open) dialog.showModal();
    headingRef.current?.focus();

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (dialog.open) dialog.close();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-modal="true"
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-3 backdrop:bg-slate-950/40 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div className="ml-auto flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--team-border)] px-5 py-4">
          <div className="min-w-0">
            <h2
              ref={headingRef}
              id={titleId}
              tabIndex={-1}
              className="text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--team-focus)] focus-visible:ring-offset-2"
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-1 text-sm text-[color:var(--team-text-muted)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={teamButtonClass("secondary", "sm")}
            onClick={() => onCloseRef.current()}
            aria-label={`Close ${title}`}
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain p-5">
          {children}
        </div>
      </div>
    </dialog>
  );
}
