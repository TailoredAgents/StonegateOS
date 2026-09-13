"use client";

import * as React from "react";
import { useMobileCompletionDraft } from "./mobile-completion-draft-context";
import type { AppointmentPaymentSummary } from "./MobilePaymentPanel";
import {
  MOBILE_APPOINTMENT_SUMMARY_EVENT,
  type MobileAppointmentSummaryEventDetail,
} from "./mobile-appointment-summary";

function dollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function parseDollars(value: string): number | null {
  const normalized = value.replace(/[$,\s]/gu, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function formatMoney(cents: number | null): string {
  if (cents === null) return "Not set";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function hasRecordedPayment(
  summary: AppointmentPaymentSummary | null,
): boolean {
  if (!summary) return false;
  return (
    summary.paidTowardJobCents > 0 ||
    summary.refundedCents > 0 ||
    ["partial", "paid", "refunded", "needs_review"].includes(summary.status)
  );
}

export function MobileCompletionFinalTotalFields({
  appointmentId,
  initialFinalTotalCents,
  quotedTotalCents,
  initialPaymentSummary,
  pricingContext,
  canManagePayments,
  forceReadOnly = false,
  modern = false,
}: {
  appointmentId: string;
  initialFinalTotalCents: number | null;
  quotedTotalCents: number | null;
  initialPaymentSummary: AppointmentPaymentSummary | null;
  pricingContext: string | null;
  canManagePayments: boolean;
  forceReadOnly?: boolean;
  modern?: boolean;
}) {
  const incomingFinalTotalCents =
    initialPaymentSummary?.jobTotalCents ?? initialFinalTotalCents;
  const incomingPaymentRecorded = hasRecordedPayment(initialPaymentSummary);
  const [paymentRecorded, setPaymentRecorded] = React.useState(
    incomingPaymentRecorded,
  );
  const [expectedFinalTotalCents, setExpectedFinalTotalCents] = React.useState(
    incomingFinalTotalCents,
  );
  const [latestFinalTotalCents, setLatestFinalTotalCents] = React.useState(
    incomingFinalTotalCents,
  );
  const [totalConflict, setTotalConflict] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [changeReason, setChangeReason] = React.useState("");
  const completionDraft = useMobileCompletionDraft();
  const restoredDraftRevisionRef = React.useRef<number | null>(null);
  const [value, setValue] = React.useState(
    dollars(incomingFinalTotalCents ?? quotedTotalCents),
  );
  const dirtyRef = React.useRef(false);
  const expectedFinalTotalCentsRef = React.useRef(expectedFinalTotalCents);
  expectedFinalTotalCentsRef.current = expectedFinalTotalCents;
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const applyIncomingTotal = React.useCallback(
    (nextTotalCents: number | null) => {
      if (
        dirtyRef.current &&
        parseDollars(valueRef.current) !== nextTotalCents
      ) {
        if (nextTotalCents !== expectedFinalTotalCentsRef.current) {
          setLatestFinalTotalCents(nextTotalCents);
          setTotalConflict(true);
        }
        return;
      }

      const nextValue = dollars(nextTotalCents ?? quotedTotalCents);
      dirtyRef.current = false;
      valueRef.current = nextValue;
      expectedFinalTotalCentsRef.current = nextTotalCents;
      setLatestFinalTotalCents(nextTotalCents);
      setExpectedFinalTotalCents(nextTotalCents);
      setTotalConflict(false);
      setValue(nextValue);
    },
    [quotedTotalCents],
  );

  React.useEffect(() => {
    setPaymentRecorded(incomingPaymentRecorded);
    applyIncomingTotal(incomingFinalTotalCents);
  }, [applyIncomingTotal, incomingFinalTotalCents, incomingPaymentRecorded]);

  React.useEffect(() => {
    const updateTotal = (event: Event) => {
      const detail = (event as CustomEvent<MobileAppointmentSummaryEventDetail>)
        .detail;
      if (
        !detail ||
        detail.appointmentId !== appointmentId ||
        !detail.paymentSummary
      ) {
        return;
      }

      const nextSummary = detail.paymentSummary;
      const nextTotalCents = nextSummary.jobTotalCents;
      setPaymentRecorded(hasRecordedPayment(nextSummary));
      applyIncomingTotal(nextTotalCents);
    };

    window.addEventListener(MOBILE_APPOINTMENT_SUMMARY_EVENT, updateTotal);
    return () => {
      window.removeEventListener(MOBILE_APPOINTMENT_SUMMARY_EVENT, updateTotal);
    };
  }, [appointmentId, applyIncomingTotal]);

  const canEdit = !forceReadOnly && (canManagePayments || !paymentRecorded);

  React.useEffect(() => {
    const draft = completionDraft?.draft;
    if (
      !modern ||
      !draft ||
      !canEdit ||
      restoredDraftRevisionRef.current === completionDraft?.revision
    )
      return;
    restoredDraftRevisionRef.current = completionDraft?.revision ?? null;
    if (draft.finalTotal !== undefined) {
      const rawBaseline = draft.expectedFinalTotalCents;
      const baseline =
        rawBaseline === "null"
          ? null
          : rawBaseline !== undefined &&
              /^\d+$/u.test(rawBaseline) &&
              Number.isSafeInteger(Number(rawBaseline))
            ? Number(rawBaseline)
            : incomingFinalTotalCents;
      expectedFinalTotalCentsRef.current = baseline;
      setExpectedFinalTotalCents(baseline);
      valueRef.current = draft.finalTotal;
      setValue(draft.finalTotal);
      dirtyRef.current = parseDollars(draft.finalTotal) !== baseline;
      setEditing(true);
      applyIncomingTotal(incomingFinalTotalCents);
    }
    if (draft.finalTotalChangeReason !== undefined) {
      setChangeReason(draft.finalTotalChangeReason);
    }
  }, [
    modern,
    completionDraft?.draft,
    completionDraft?.revision,
    canEdit,
    applyIncomingTotal,
    incomingFinalTotalCents,
  ]);

  const showEditor =
    !modern || editing || totalConflict || parseDollars(value) === null;

  if (!canEdit) {
    return (
      <div className="rounded-md border border-emerald-300/20 bg-slate-950 px-3 py-2">
        <input type="hidden" name="preserveFinalTotal" value="1" />
        <p className="text-xs font-semibold text-slate-400">Final job total</p>
        <p className="mt-1 text-sm font-semibold text-emerald-100">
          {formatMoney(latestFinalTotalCents)}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Ask someone with payment management access to change the total.
        </p>
      </div>
    );
  }

  return (
    <>
      {latestFinalTotalCents === null &&
      pricingContext &&
      (!modern || parseDollars(value) === null) ? (
        <div className="rounded-md border border-emerald-300/20 bg-slate-950 px-3 py-2 text-sm font-semibold text-emerald-100">
          {pricingContext}
        </div>
      ) : null}
      <input
        type="hidden"
        name="expectedFinalTotalCents"
        value={
          expectedFinalTotalCents === null
            ? "null"
            : String(expectedFinalTotalCents)
        }
      />
      {totalConflict ? (
        <div className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <p>
            The final total changed elsewhere to{" "}
            {formatMoney(latestFinalTotalCents)} while you were editing.
          </p>
          <button
            type="button"
            className="mt-2 rounded-md border border-amber-200/40 px-3 py-2 text-xs font-semibold"
            onClick={() => {
              const nextValue = dollars(
                latestFinalTotalCents ?? quotedTotalCents,
              );
              dirtyRef.current = false;
              valueRef.current = nextValue;
              expectedFinalTotalCentsRef.current = latestFinalTotalCents;
              setExpectedFinalTotalCents(latestFinalTotalCents);
              setTotalConflict(false);
              setValue(nextValue);
            }}
          >
            Use latest amount
          </button>
        </div>
      ) : null}
      {!showEditor ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-950 px-3 py-2">
          <input type="hidden" name="finalTotal" value={value} />
          <div>
            <p className="text-xs font-semibold text-slate-400">
              Final job total
            </p>
            <p className="mt-1 text-base font-semibold text-white">
              {formatMoney(parseDollars(value))}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-h-11 rounded-md px-3 text-sm font-semibold text-cyan-100"
          >
            Change total
          </button>
        </div>
      ) : (
        <label className="block">
          <span className="text-xs font-semibold text-slate-300">
            Final job total
          </span>
          <input
            name="finalTotal"
            type="number"
            min={0}
            step="0.01"
            required
            value={value}
            onChange={(event) => {
              const nextValue = event.target.value;
              const nextCents = parseDollars(nextValue);
              if (
                totalConflict &&
                latestFinalTotalCents !== expectedFinalTotalCents &&
                nextCents === latestFinalTotalCents
              ) {
                dirtyRef.current = false;
                expectedFinalTotalCentsRef.current = latestFinalTotalCents;
                setExpectedFinalTotalCents(latestFinalTotalCents);
                setTotalConflict(false);
              } else {
                dirtyRef.current = nextCents !== expectedFinalTotalCents;
              }
              valueRef.current = nextValue;
              setValue(nextValue);
            }}
            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
            placeholder="350"
          />
        </label>
      )}
      {paymentRecorded && canManagePayments ? (
        modern && !showEditor ? (
          <input
            type="hidden"
            name="finalTotalChangeReason"
            value={changeReason}
          />
        ) : (
          <label className="block">
            <span className="text-xs font-semibold text-slate-300">
              Reason for changing a paid job
            </span>
            <input
              name="finalTotalChangeReason"
              type="text"
              maxLength={500}
              {...(modern
                ? {
                    value: changeReason,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      setChangeReason(event.target.value),
                  }
                : {})}
              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
              placeholder="Required only if the total changes"
            />
          </label>
        )
      ) : null}
      {paymentRecorded && showEditor ? (
        <p className="mt-1 text-xs leading-5 text-slate-500">
          This job already has a recorded payment. Payment-management access is
          required to change its total, and the total cannot be less than the
          amount paid.
        </p>
      ) : null}
    </>
  );
}
