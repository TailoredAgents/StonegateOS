"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, MapPin } from "lucide-react";

type MobileJobViewProps = {
  id: string;
  appointmentId: string;
  titleId: string;
  customerName: string;
  timeLabel: string;
  categoryLabel: string;
  statusLabel: string;
  statusClassName: string;
  partnerName: string | null;
  isPartner: boolean;
  address?: string | null;
  mapsHref?: string | null;
  scope: string;
  canFinish: boolean;
  originLocation?: string;
  quickActions?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
};

function listLocation(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("jobId");
  return `${url.pathname}${url.search}${url.hash}`;
}

function revealCompletion(panel: HTMLElement): void {
  const completion = panel.querySelector<HTMLElement>(
    "[data-mobile-completion]",
  );
  if (!completion) return;
  // A permitted completion form may sit inside a secondary details section.
  // Reveal only its ancestors; never expand unrelated forms or submit anything.
  let ancestor: HTMLElement | null = completion;
  while (ancestor && ancestor !== panel) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  requestAnimationFrame(() => {
    completion.scrollIntoView({ block: "start", behavior: "auto" });
    const target = completion.querySelector<HTMLElement>("summary, h2, h3");
    if (target) {
      if (!target.matches("summary") && !target.hasAttribute("tabindex"))
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
}

/** One mounted job view, outside the schedule's stacking/overflow contexts. */
export function MobileJobView({
  id,
  appointmentId,
  titleId,
  customerName,
  timeLabel,
  categoryLabel,
  statusLabel,
  statusClassName,
  partnerName,
  isPartner,
  address,
  mapsHref,
  scope,
  canFinish,
  originLocation,
  quickActions,
  children,
  onClose,
}: MobileJobViewProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const [hasCompletion, setHasCompletion] = React.useState(false);
  const [completionOpen, setCompletionOpen] = React.useState(false);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const scrollPosition = window.scrollY;
    const returnLocation = listLocation();
    document.body.style.overflow = "hidden";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    backRef.current?.focus({ preventScroll: true });

    const refreshCompletion = () => {
      const completion = dialog.querySelector("[data-mobile-completion]");
      setHasCompletion(Boolean(completion));
      setCompletionOpen(
        completion instanceof HTMLDetailsElement && completion.open,
      );
    };
    refreshCompletion();
    const observer = new MutationObserver(refreshCompletion);
    observer.observe(dialog, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });

    return () => {
      observer.disconnect();
      document.body.style.overflow = previousOverflow;
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      const currentLocation = listLocation();
      if (
        currentLocation === returnLocation ||
        currentLocation === originLocation
      ) {
        window.scrollTo({ top: scrollPosition, behavior: "instant" });
        if (previouslyFocused?.isConnected)
          previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [originLocation]);

  return createPortal(
    <dialog
      id={id}
      ref={dialogRef}
      data-mobile-job-panel
      data-appointment-id={appointmentId}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(":disabled") &&
              element.getClientRects().length > 0,
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault();
            last.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === last &&
            first
          ) {
            event.preventDefault();
            first.focus();
          }
        }
        if (
          event.key === "Escape" &&
          typeof dialogRef.current?.showModal !== "function"
        ) {
          event.preventDefault();
          closeRef.current();
        }
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-slate-950 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70 sm:mx-auto sm:max-w-2xl [&_button]:min-h-11 [&_summary]:min-h-11"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="shrink-0 border-b border-white/10 bg-slate-950 px-4 pb-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="flex items-start justify-between gap-3">
            <button
              ref={backRef}
              type="button"
              onClick={onClose}
              aria-label="Back to jobs"
              className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-cyan-100 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              Back
            </button>
            <span
              className={`mt-2 max-w-[60%] rounded-full px-2.5 py-1 text-xs font-semibold ${statusClassName}`}
            >
              {statusLabel}
            </span>
          </div>
          {isPartner ? (
            <p className="mb-1 break-words text-xs font-semibold text-cyan-200">
              Partner{partnerName ? ` · ${partnerName}` : ""}
            </p>
          ) : null}
          <p className="text-sm text-slate-300">
            {timeLabel} · {categoryLabel}
          </p>
          <h2
            id={titleId}
            className="mt-1 break-words text-xl font-semibold leading-7 text-white"
          >
            {customerName}
          </h2>
        </header>

        <div
          data-mobile-job-scroll
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {scope ? (
            <section aria-label="Work details" className="space-y-1">
              <h3 className="text-sm font-semibold text-white">Work details</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                {scope}
              </p>
            </section>
          ) : null}

          {address ? (
            mapsHref ? (
              <a
                href={mapsHref}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open directions to ${address}`}
                className="flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium leading-6 text-cyan-100 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                <MapPin className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{address}</span>
                <span className="ml-auto shrink-0 text-xs">Directions</span>
              </a>
            ) : (
              <p className="break-words text-sm leading-6 text-slate-300">
                {address}
              </p>
            )
          ) : null}

          {quickActions ? (
            <div className="flex flex-wrap gap-2">{quickActions}</div>
          ) : null}
          <div className="space-y-4">{children}</div>
        </div>

        {canFinish && hasCompletion && !completionOpen ? (
          <footer className="shrink-0 border-t border-white/10 bg-slate-950 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() =>
                dialogRef.current && revealCompletion(dialogRef.current)
              }
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-base font-semibold text-slate-950 outline-none hover:bg-cyan-200 focus-visible:ring-2 focus-visible:ring-white"
            >
              <Check className="h-5 w-5" aria-hidden="true" />
              Finish job
            </button>
          </footer>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
