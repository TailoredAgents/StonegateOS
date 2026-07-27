"use client";

import * as React from "react";
import { ChevronDown, MapPin } from "lucide-react";
import type { AppointmentPaymentSummary } from "./MobilePaymentPanel";
import type { AppointmentMediaSummary } from "./MobileQuotedWorkPanel";

type AppointmentCardStatusTone =
  | "default"
  | "requested"
  | "confirmed"
  | "completed"
  | "quote"
  | "canceled";

type SummaryChip = {
  key: string;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
};

function statusClassName(tone: AppointmentCardStatusTone): string {
  if (tone === "canceled") {
    return "bg-rose-300/10 text-rose-100 ring-1 ring-inset ring-rose-300/30";
  }
  if (tone === "completed") {
    return "bg-emerald-300/10 text-emerald-100 ring-1 ring-inset ring-emerald-300/30";
  }
  if (tone === "confirmed") {
    return "bg-cyan-300/10 text-cyan-100 ring-1 ring-inset ring-cyan-300/30";
  }
  if (tone === "requested") {
    return "bg-amber-300/10 text-amber-100 ring-1 ring-inset ring-amber-300/30";
  }
  if (tone === "quote") {
    return "bg-sky-300/10 text-sky-100 ring-1 ring-inset ring-sky-300/30";
  }
  return "bg-slate-800 text-slate-200 ring-1 ring-inset ring-white/10";
}

function chipClassName(tone: SummaryChip["tone"]): string {
  if (tone === "danger") {
    return "inline-flex min-h-7 items-center rounded-full bg-rose-300/10 px-2.5 py-1 text-xs font-semibold text-rose-100 ring-1 ring-inset ring-rose-300/30";
  }
  if (tone === "warning") {
    return "inline-flex min-h-7 items-center rounded-full bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100 ring-1 ring-inset ring-amber-300/30";
  }
  if (tone === "success") {
    return "inline-flex min-h-7 items-center rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-emerald-200 ring-1 ring-inset ring-white/10";
  }
  return "inline-flex min-h-7 items-center rounded-full bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 ring-1 ring-inset ring-white/10";
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function paymentChip(
  summary: AppointmentPaymentSummary | null | undefined,
): SummaryChip | null {
  if (!summary) return null;

  if (summary.status === "needs_review") {
    return {
      key: "payment",
      label: "Payment review",
      tone: "danger",
    };
  }
  if (summary.activeAttemptId) {
    return {
      key: "payment",
      label: "Payment pending",
      tone: "warning",
    };
  }
  if (summary.status === "refunded") {
    return {
      key: "payment",
      label: "Refunded",
      tone: "warning",
    };
  }
  if (
    (summary.status === "unpaid" || summary.status === "partial") &&
    summary.balanceCents !== null &&
    summary.balanceCents > 0
  ) {
    return {
      key: "payment",
      label: `${formatMoney(summary.balanceCents)} due`,
      tone: "warning",
    };
  }
  if (summary.status === "partial") {
    return {
      key: "payment",
      label: "Partially paid",
      tone: "warning",
    };
  }
  if (summary.status === "unpaid") {
    return {
      key: "payment",
      label: "Unpaid",
      tone: "warning",
    };
  }
  if (summary.status === "paid") {
    return {
      key: "payment",
      label: "Paid",
      tone: "success",
    };
  }
  return null;
}

export function MobileAppointmentCard({
  cardId,
  timeLabel,
  customerName,
  statusLabel,
  statusTone,
  address,
  mapsHref,
  quotedScopeText,
  mediaSummary,
  paymentSummary,
  amountLabel,
  hasDetails = true,
  defaultOpen = false,
  children,
}: {
  cardId: string;
  timeLabel: string;
  customerName: string;
  statusLabel: string;
  statusTone: AppointmentCardStatusTone;
  address?: string | null;
  mapsHref?: string | null;
  quotedScopeText?: string | null;
  mediaSummary?: AppointmentMediaSummary | null;
  paymentSummary?: AppointmentPaymentSummary | null;
  amountLabel?: string | null;
  hasDetails?: boolean;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const reactId = React.useId();
  const detailsId = `mobile-appointment-details-${reactId.replaceAll(":", "")}`;
  const canExpand = hasDetails && React.Children.count(children) > 0;
  const scope = quotedScopeText?.trim() ?? "";
  const chips: SummaryChip[] = [];

  if (mediaSummary?.needsScope) {
    chips.push({
      key: "scope",
      label: "Scope needed",
      tone: "warning",
    });
  }

  if (mediaSummary && mediaSummary.readyCount > 0) {
    chips.push({
      key: "photos",
      label: `${mediaSummary.readyCount} ${
        mediaSummary.readyCount === 1 ? "photo" : "photos"
      }`,
      tone: "neutral",
    });
  }

  if (mediaSummary && mediaSummary.pendingCount > 0) {
    chips.push({
      key: "processing",
      label: `${mediaSummary.pendingCount} processing`,
      tone: "warning",
    });
  }

  const summaryPaymentChip = paymentChip(paymentSummary);
  if (summaryPaymentChip) chips.push(summaryPaymentChip);

  if (!summaryPaymentChip && amountLabel?.trim()) {
    chips.push({
      key: "amount",
      label: amountLabel.trim(),
      tone: "neutral",
    });
  }

  React.useEffect(() => {
    const closeWhenAnotherCardOpens = (event: Event) => {
      const detail = (event as CustomEvent<{ cardId?: string }>).detail;
      if (detail?.cardId && detail.cardId !== cardId) setOpen(false);
    };
    window.addEventListener(
      "stonegate:mobile-appointment-open",
      closeWhenAnotherCardOpens,
    );
    return () => {
      window.removeEventListener(
        "stonegate:mobile-appointment-open",
        closeWhenAnotherCardOpens,
      );
    };
  }, [cardId]);

  const toggleOpen = () => {
    const next = !open;
    if (next) {
      window.dispatchEvent(
        new CustomEvent("stonegate:mobile-appointment-open", {
          detail: { cardId },
        }),
      );
    }
    setOpen(next);
  };

  const headerContent = (
    <>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-cyan-200">
          {timeLabel}
        </span>
        <span className="mt-1 block truncate text-base font-semibold leading-5 text-white">
          {customerName}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span
          className={`max-w-36 truncate rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${statusClassName(
            statusTone,
          )}`}
        >
          {statusLabel}
        </span>
        {canExpand ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400">
            {open ? "Hide details" : "Show details"}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                open ? "rotate-180" : "rotate-0"
              }`}
              aria-hidden="true"
            />
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <article
      aria-label={`Appointment with ${customerName}`}
      data-appointment-id={cardId}
      className="overflow-hidden rounded-xl border border-white/10 bg-slate-900/90 shadow-sm shadow-black/20"
    >
      {canExpand ? (
        <button
          type="button"
          className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={toggleOpen}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex min-h-14 w-full items-center gap-3 px-4 py-3">
          {headerContent}
        </div>
      )}

      {address ? (
        mapsHref ? (
          <a
            href={mapsHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open directions to ${address}`}
            className="flex min-h-11 items-center gap-2 border-t border-white/10 px-4 py-2 text-sm font-medium leading-5 text-cyan-100 outline-none transition-colors hover:bg-white/[0.04] hover:text-cyan-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300"
          >
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="line-clamp-1">{address}</span>
          </a>
        ) : (
          <p className="flex min-h-11 items-center gap-2 border-t border-white/10 px-4 py-2 text-sm leading-5 text-slate-300">
            <MapPin
              className="h-4 w-4 shrink-0 text-slate-500"
              aria-hidden="true"
            />
            <span className="line-clamp-1">{address}</span>
          </p>
        )
      ) : null}

      {scope ? (
        <p className="line-clamp-1 border-t border-white/10 px-4 py-2.5 text-sm leading-5 text-slate-300">
          <span className="font-semibold text-slate-200">Quoted work: </span>
          {scope}
        </p>
      ) : null}

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-white/10 px-4 py-2.5">
          {chips.map((chip) => (
            <span key={chip.key} className={chipClassName(chip.tone)}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      {canExpand ? (
        <div
          id={detailsId}
          hidden={!open}
          className="space-y-3 border-t border-white/10 bg-slate-950/40 p-3"
        >
          {open ? children : null}
        </div>
      ) : null}
    </article>
  );
}
