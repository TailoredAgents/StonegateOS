"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { ChevronDown, MapPin } from "lucide-react";
import { MobileJobView } from "./MobileJobView";
import type { AppointmentPaymentSummary } from "./MobilePaymentPanel";
import type { AppointmentMediaSummary } from "./MobileQuotedWorkPanel";
import {
  MOBILE_APPOINTMENT_SUMMARY_EVENT,
  type MobileAppointmentSummaryEventDetail,
} from "./mobile-appointment-summary";
import {
  appointmentCardStatusClassName,
  appointmentCardSurfaceClassName,
  appointmentCardTimeClassName,
  type AppointmentCardStatusTone,
} from "./mobile-appointment-card-styles";

type SummaryChip = {
  key: string;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
};

export type MobileBookingPartnerAffiliation = {
  accountId: string | null;
  bookingId: string | null;
  displayName: string | null;
  basis: string;
};

type MobileJobHistoryState = {
  cardId: string;
  returnLocation: string;
};

function currentHistoryState(): Record<string, unknown> {
  const value: unknown = window.history.state;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
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

function mediaSummarySnapshot(
  summary: AppointmentMediaSummary | null | undefined,
): string {
  if (!summary) return "none";
  return [
    summary.readyCount,
    summary.pendingCount,
    summary.coverMediaId ?? "",
    summary.needsScope ? "1" : "0",
  ].join("|");
}

function paymentSummarySnapshot(
  summary: AppointmentPaymentSummary | null | undefined,
): string {
  if (!summary) return "none";
  return [
    summary.status,
    summary.jobTotalCents ?? "",
    summary.paidTowardJobCents,
    summary.tipCents,
    summary.refundedCents,
    summary.balanceCents ?? "",
    summary.activeAttemptId ?? "",
    summary.latestReceiptUrl ?? "",
  ].join("|");
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
  serviceCategoryLabel,
  partnerAffiliation,
  modern = true,
  quickActions,
  jobHref,
  hasDetails = true,
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
  serviceCategoryLabel?: string | null;
  partnerAffiliation?: MobileBookingPartnerAffiliation | null;
  employeeId?: string;
  appointmentVersion?: string | null;
  modern?: boolean;
  quickActions?: React.ReactNode;
  jobHref?: string;
  hasDetails?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const openAtLocation = React.useRef(false);
  const openedFromList = React.useRef<MobileJobHistoryState | null>(null);
  const [currentScope, setCurrentScope] = React.useState(quotedScopeText);
  const [currentMediaSummary, setCurrentMediaSummary] =
    React.useState(mediaSummary);
  const [currentPaymentSummary, setCurrentPaymentSummary] =
    React.useState(paymentSummary);
  const incomingMediaSummary = React.useRef(mediaSummary);
  const incomingPaymentSummary = React.useRef(paymentSummary);
  // Keep a successful in-card update through a stale refresh, but accept any
  // genuinely new server snapshot (for example, a Square webhook) immediately.
  const scopeOverride = React.useRef<{
    base: string | null | undefined;
  } | null>(null);
  const mediaOverride = React.useRef<string | null>(null);
  const paymentOverride = React.useRef<string | null>(null);
  incomingMediaSummary.current = mediaSummary;
  incomingPaymentSummary.current = paymentSummary;
  const incomingMediaSnapshot = mediaSummarySnapshot(mediaSummary);
  const incomingPaymentSnapshot = paymentSummarySnapshot(paymentSummary);
  const reactId = React.useId();
  const detailsId = `mobile-appointment-details-${reactId.replaceAll(":", "")}`;
  const titleId = `${detailsId}-title`;
  const canExpand = hasDetails && React.Children.count(children) > 0;
  const categoryLabel = serviceCategoryLabel?.trim() || "Job";
  const isPartner = Boolean(
    partnerAffiliation &&
      (partnerAffiliation.basis === "partner_booking" ||
        partnerAffiliation.basis === "appointment_account") &&
      (partnerAffiliation.accountId || partnerAffiliation.bookingId),
  );
  const partnerName = partnerAffiliation?.displayName?.trim() || null;
  const scope = currentScope?.trim() ?? "";
  const normalizedAmountLabel = amountLabel?.trim() ?? "";
  const completedAmountLabel =
    statusTone === "completed" && normalizedAmountLabel
      ? normalizedAmountLabel
      : null;
  const chips: SummaryChip[] = [];

  if (currentMediaSummary?.needsScope) {
    chips.push({
      key: "scope",
      label: "Scope needed",
      tone: "warning",
    });
  }

  if (currentMediaSummary && currentMediaSummary.readyCount > 0) {
    chips.push({
      key: "photos",
      label: `${currentMediaSummary.readyCount} ${
        currentMediaSummary.readyCount === 1 ? "photo" : "photos"
      }`,
      tone: "neutral",
    });
  }

  if (currentMediaSummary && currentMediaSummary.pendingCount > 0) {
    chips.push({
      key: "processing",
      label: `${currentMediaSummary.pendingCount} processing`,
      tone: "warning",
    });
  }

  const summaryPaymentChip = paymentChip(currentPaymentSummary);
  if (summaryPaymentChip) {
    const duplicatesCompletedTotal =
      completedAmountLabel !== null &&
      currentPaymentSummary?.status === "unpaid" &&
      currentPaymentSummary.jobTotalCents !== null &&
      currentPaymentSummary.balanceCents ===
        currentPaymentSummary.jobTotalCents;
    chips.push(
      duplicatesCompletedTotal
        ? { ...summaryPaymentChip, label: "Unpaid" }
        : summaryPaymentChip,
    );
  }

  if (!summaryPaymentChip && normalizedAmountLabel && !completedAmountLabel) {
    chips.push({
      key: "amount",
      label: normalizedAmountLabel,
      tone: "neutral",
    });
  }

  React.useEffect(() => {
    const closeWhenAnotherCardOpens = (event: Event) => {
      const detail = (event as CustomEvent<{ cardId?: string }>).detail;
      if (detail?.cardId && detail.cardId !== cardId) {
        openAtLocation.current = false;
        setOpen(false);
      }
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

  React.useEffect(() => {
    if (!modern || !canExpand) return;
    const syncFromLocation = () => {
      const jobId = new URL(window.location.href).searchParams.get("jobId");
      const wasOpen = openAtLocation.current;
      openAtLocation.current = jobId === cardId;
      setOpen(openAtLocation.current);
      if (wasOpen && !jobId) requestAnimationFrame(() => router.refresh());
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [cardId, modern, canExpand, router]);

  React.useEffect(() => {
    if (scopeOverride.current?.base === quotedScopeText) {
      return;
    }
    scopeOverride.current = null;
    setCurrentScope(quotedScopeText);
  }, [quotedScopeText]);

  React.useEffect(() => {
    if (
      mediaOverride.current !== null &&
      mediaOverride.current === incomingMediaSnapshot
    ) {
      return;
    }
    mediaOverride.current = null;
    setCurrentMediaSummary(incomingMediaSummary.current);
  }, [incomingMediaSnapshot]);

  React.useEffect(() => {
    if (
      paymentOverride.current !== null &&
      paymentOverride.current === incomingPaymentSnapshot
    ) {
      return;
    }
    paymentOverride.current = null;
    setCurrentPaymentSummary(incomingPaymentSummary.current);
  }, [incomingPaymentSnapshot]);

  React.useEffect(() => {
    const updateSummary = (event: Event) => {
      const detail = (event as CustomEvent<MobileAppointmentSummaryEventDetail>)
        .detail;
      if (!detail || detail.appointmentId !== cardId) return;
      if ("quotedScopeText" in detail) {
        scopeOverride.current =
          detail.quotedScopeText === quotedScopeText
            ? null
            : { base: quotedScopeText };
        setCurrentScope(detail.quotedScopeText);
      }
      if (detail.mediaSummary) {
        const nextSnapshot = mediaSummarySnapshot(detail.mediaSummary);
        mediaOverride.current =
          nextSnapshot === incomingMediaSnapshot ? null : incomingMediaSnapshot;
        setCurrentMediaSummary(detail.mediaSummary);
      }
      if (detail.paymentSummary) {
        const nextSnapshot = paymentSummarySnapshot(detail.paymentSummary);
        paymentOverride.current =
          nextSnapshot === incomingPaymentSnapshot
            ? null
            : incomingPaymentSnapshot;
        setCurrentPaymentSummary(detail.paymentSummary);
      }
    };
    window.addEventListener(MOBILE_APPOINTMENT_SUMMARY_EVENT, updateSummary);
    return () => {
      window.removeEventListener(
        MOBILE_APPOINTMENT_SUMMARY_EVENT,
        updateSummary,
      );
    };
  }, [cardId, incomingMediaSnapshot, incomingPaymentSnapshot, quotedScopeText]);

  const toggleOpen = () => {
    const next = !open;
    openAtLocation.current = next;
    if (next) {
      if (modern) {
        const url = new URL(window.location.href);
        const returnLocation = `${url.pathname}${url.search}${url.hash}`;
        if (jobHref) {
          try {
            const jobUrl = new URL(jobHref, window.location.origin);
            if (
              jobUrl.origin === url.origin &&
              jobUrl.pathname === url.pathname
            ) {
              const screen = jobUrl.searchParams.get("screen");
              const date = jobUrl.searchParams.get("date");
              if (screen === "myday" || screen === "calendar")
                url.searchParams.set("screen", screen);
              if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date))
                url.searchParams.set("date", date);
            }
          } catch {
            // Missing optional link context must not prevent opening the job.
          }
        }
        url.searchParams.set("jobId", cardId);
        const state: MobileJobHistoryState = { cardId, returnLocation };
        // A router refresh clears custom history state, but must not lose the
        // list entry that this mounted card should return to after a save.
        openedFromList.current = state;
        window.history.pushState(
          // Next copies its own state. Spreading history.state here would pass
          // its internal marker and bypass canonical-URL synchronization.
          { stonegateMobileJob: state },
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
      window.dispatchEvent(
        new CustomEvent("stonegate:mobile-appointment-open", {
          detail: { cardId },
        }),
      );
    }
    setOpen(next);
  };

  const closeJob = () => {
    openAtLocation.current = false;
    setOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get("jobId") !== cardId) return;
    const state = (currentHistoryState()["stonegateMobileJob"] ??
      openedFromList.current) as MobileJobHistoryState | null | undefined;
    if (state?.cardId === cardId && state.returnLocation) {
      window.addEventListener(
        "popstate",
        () => {
          requestAnimationFrame(() => router.refresh());
        },
        { once: true },
      );
      window.history.back();
    } else {
      url.searchParams.delete("jobId");
      // A direct job link has no known list entry to traverse. Use a router
      // navigation so the server also receives the cleared selection.
      router.replace(`${url.pathname}${url.search}${url.hash}` as Route, {
        scroll: false,
      });
    }
  };

  if (modern) {
    const attention = chips.filter(
      (chip) =>
        chip.key === "scope" ||
        (chip.key === "payment" && chip.tone !== "success"),
    );
    return (
      <>
        <article
          aria-label={`Appointment with ${customerName}`}
          data-appointment-id={cardId}
          className={`overflow-hidden rounded-xl border shadow-sm shadow-black/20 ${appointmentCardSurfaceClassName(statusTone)}`}
        >
          {isPartner ? (
            <div className="border-b border-cyan-200/10 bg-cyan-300/[0.06] px-4 py-1.5 text-xs font-semibold leading-5 text-cyan-100">
              <span className="break-words">
                Partner{partnerName ? ` · ${partnerName}` : ""}
              </span>
            </div>
          ) : null}
          <div className="px-4 pt-3">
            <div className="flex items-start justify-between gap-3">
              <p
                className={`min-w-0 text-sm font-semibold leading-6 ${appointmentCardTimeClassName(statusTone)}`}
              >
                {timeLabel}
              </p>
              <span
                className={`max-w-[50%] shrink-0 break-words rounded-full px-2.5 py-1 text-xs font-semibold ${appointmentCardStatusClassName(statusTone)}`}
              >
                {statusLabel}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-32">
                <p className="text-xs font-semibold leading-5 text-cyan-100">
                  {categoryLabel}
                </p>
                {canExpand ? (
                  <button
                    type="button"
                    aria-label={`Open job for ${customerName}`}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-controls={open ? detailsId : undefined}
                    onClick={toggleOpen}
                    className="block min-h-11 w-full break-words rounded-lg py-1 text-left text-lg font-semibold leading-6 text-white outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                  >
                    {customerName}
                  </button>
                ) : (
                  <p className="break-words py-1 text-lg font-semibold leading-6 text-white">
                    {customerName}
                  </p>
                )}
              </div>
              {normalizedAmountLabel ? (
                <div className="ml-auto max-w-full rounded-xl bg-white/[0.05] px-3 py-2 text-right ring-1 ring-inset ring-white/10">
                  <p className="text-[11px] font-medium leading-4 text-slate-300">
                    Job price
                  </p>
                  <p className="break-words text-xl font-semibold leading-7 tracking-tight text-white tabular-nums">
                    {normalizedAmountLabel}
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          {address ? (
            mapsHref ? (
              <a
                href={mapsHref}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open directions to ${address}`}
                className="flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-medium leading-5 text-cyan-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300"
              >
                <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-words">{address}</span>
                <span className="shrink-0 text-xs">Directions</span>
              </a>
            ) : (
              <p className="px-4 py-2 text-sm leading-5 text-slate-300">
                {address}
              </p>
            )
          ) : null}
          {scope ? (
            <p
              className={`mx-4 mb-3 whitespace-pre-wrap break-words text-sm leading-5 text-slate-300 ${canExpand ? "line-clamp-2" : ""}`}
            >
              {scope}
            </p>
          ) : null}
          {attention.length ? (
            <p
              className={`px-4 pb-3 text-xs font-medium leading-5 ${attention.some((chip) => chip.tone === "danger") ? "text-rose-200" : "text-amber-100"}`}
            >
              {attention.map((chip) => chip.label).join(" · ")}
            </p>
          ) : null}
          {canExpand || quickActions ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2">
              {quickActions}
              {canExpand ? (
                <button
                  type="button"
                  onClick={toggleOpen}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  className="ml-auto inline-flex min-h-11 items-center justify-center rounded-lg bg-white/[0.07] px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-cyan-300"
                >
                  Open job
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
        {open && canExpand ? (
          <MobileJobView
            id={detailsId}
            appointmentId={cardId}
            titleId={titleId}
            customerName={customerName}
            timeLabel={timeLabel}
            categoryLabel={categoryLabel}
            statusLabel={statusLabel}
            statusClassName={appointmentCardStatusClassName(statusTone)}
            partnerName={partnerName}
            isPartner={isPartner}
            address={address}
            mapsHref={mapsHref}
            scope={scope}
            canFinish={statusTone !== "completed" && statusTone !== "canceled"}
            originLocation={openedFromList.current?.returnLocation}
            quickActions={quickActions}
            onClose={closeJob}
          >
            {children}
          </MobileJobView>
        ) : null}
      </>
    );
  }

  const headerContent = (
    <>
      <span className="min-w-0 flex-1 text-left">
        <span
          className={`block text-xs font-semibold uppercase tracking-[0.12em] ${appointmentCardTimeClassName(statusTone)}`}
        >
          {timeLabel}
        </span>
        <span className="mt-1 block truncate text-base font-semibold leading-5 text-white">
          {customerName}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span
          className={`max-w-36 whitespace-normal break-words rounded-full px-2.5 py-1 text-right text-[11px] font-semibold uppercase tracking-[0.08em] ${appointmentCardStatusClassName(statusTone)}`}
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
      className={`overflow-hidden rounded-xl border shadow-sm shadow-black/20 ${appointmentCardSurfaceClassName(statusTone)}`}
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
        <p className="whitespace-pre-wrap break-words border-t border-white/10 px-4 py-2.5 text-sm leading-5 text-slate-300">
          <span className="font-semibold text-slate-200">Quoted work: </span>
          {scope}
        </p>
      ) : null}

      {completedAmountLabel ? (
        <p className="border-t border-white/10 px-4 py-2.5 text-sm font-semibold leading-5 text-emerald-100">
          Final total {completedAmountLabel}
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
