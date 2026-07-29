"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import type { OfflinePaymentSummary } from "./lib/offline-media";
import { publishMobileAppointmentSummary } from "./mobile-appointment-summary";

export type AppointmentPaymentSummary = OfflinePaymentSummary;

type PaymentRow = {
  id: string;
  provider: string | null;
  canonicalStatus: string | null;
  jobAmountCents: number | null;
  tipCents: number | null;
  refundedAmountCents: number | null;
  tenderType: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  legacySource: string | null;
  paidAt: string | null;
  createdAt: string;
};

type PaymentsResponse = {
  ledgerAvailable?: boolean;
  paymentSummary?: AppointmentPaymentSummary;
  payments?: PaymentRow[];
  attempts?: Array<{
    id: string;
    status: string;
    requestedJobAmountCents: number;
    errorMessage?: string | null;
    createdAt: string;
  }>;
};

function formatMoney(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "Not set";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function statusLabel(status: AppointmentPaymentSummary["status"]): string {
  if (status === "needs_review") return "Needs review";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClass(status: AppointmentPaymentSummary["status"]): string {
  if (status === "paid") return "bg-emerald-300 text-slate-950";
  if (status === "needs_review") return "bg-rose-300 text-slate-950";
  if (status === "partial" || status === "refunded") {
    return "bg-amber-300 text-slate-950";
  }
  return "bg-slate-800 text-slate-200";
}

function centsFromDollars(value: string): number | null {
  const normalized = value.replace(/[$,\s]/gu, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function platform(): "ios" | "android" {
  const userAgent = navigator.userAgent;
  const isAppleTouchMac =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/u.test(userAgent) || isAppleTouchMac
    ? "ios"
    : "android";
}

function openSquare(
  launchUrl: string,
  targetPlatform: "ios" | "android",
): void {
  if (targetPlatform !== "ios") {
    window.location.assign(launchUrl);
    return;
  }

  let squareOpened = false;
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") squareOpened = true;
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (!squareOpened && document.visibilityState === "visible") {
      window.location.assign("/mobile/square-setup?reason=app_missing");
    }
  }, 2_500);
  window.location.assign(launchUrl);
}

async function errorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const candidate = payload?.["message"] ?? payload?.["error"];
  if (typeof candidate === "string" && candidate.trim()) {
    const code = candidate.trim();
    const messages: Record<string, string> = {
      square_pos_disabled: "Square Tap to Pay is not enabled yet.",
      square_not_configured: "Square setup is incomplete. Ask the owner.",
      quoted_scope_required:
        "Add the quoted-to-remove summary before taking payment.",
      appointment_already_paid: "This appointment is already paid.",
      appointment_not_collectible:
        "Payments cannot be collected for a canceled, no-show, or quote-only appointment.",
      final_total_required: "Set the final job total first.",
      owner_required_after_payment:
        "Only an owner can change the total after payment starts.",
      change_reason_required:
        "Enter a reason for changing the total after payment.",
      final_total_below_net_paid:
        "The final total cannot be below the amount already paid.",
      square_verification_in_progress:
        "Finish or reconcile the active Square payment before changing the total or collecting another payment.",
      square_reconciliation_required:
        "The previous Square attempt needs owner review before another payment can start.",
    };
    return messages[code] ?? code.replaceAll("_", " ");
  }
  return fallback;
}

export function MobilePaymentPanel({
  appointmentId,
  initialSummary,
  initialLedgerAvailable,
  canCollect,
  isOwner,
  needsScope,
}: {
  appointmentId: string;
  initialSummary: AppointmentPaymentSummary;
  initialLedgerAvailable: boolean;
  canCollect: boolean;
  isOwner: boolean;
  needsScope: boolean;
}) {
  const router = useRouter();
  const [summary, setSummary] = React.useState(initialSummary);
  const [ledgerAvailable, setLedgerAvailable] = React.useState(
    initialLedgerAvailable,
  );
  const [rows, setRows] = React.useState<PaymentRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [online, setOnline] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [finalTotal, setFinalTotal] = React.useState(
    initialSummary.jobTotalCents == null
      ? ""
      : (initialSummary.jobTotalCents / 100).toFixed(2),
  );
  const [changeReason, setChangeReason] = React.useState("");
  const [manualTender, setManualTender] = React.useState<"cash" | "check">(
    "cash",
  );
  const [manualTip, setManualTip] = React.useState("");
  const [manualNote, setManualNote] = React.useState("");
  const finalTotalDirtyRef = React.useRef(false);
  const finalTotalEditRevisionRef = React.useRef(0);
  const paymentLoadRevisionRef = React.useRef(0);

  const applySummary = React.useCallback(
    (nextSummary: AppointmentPaymentSummary) => {
      setSummary(nextSummary);
      publishMobileAppointmentSummary({
        appointmentId,
        paymentSummary: nextSummary,
      });
    },
    [appointmentId],
  );

  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const load = React.useCallback(async () => {
    if (!navigator.onLine) return;
    const loadRevision = ++paymentLoadRevisionRef.current;
    const editRevisionAtStart = finalTotalEditRevisionRef.current;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/payments`,
        { cache: "no-store" },
      );
      if (loadRevision !== paymentLoadRevisionRef.current) return;
      if (response.ok) {
        const payload = (await response.json()) as PaymentsResponse;
        if (loadRevision !== paymentLoadRevisionRef.current) return;
        if (typeof payload.ledgerAvailable === "boolean") {
          setLedgerAvailable(payload.ledgerAvailable);
        }
        if (payload.paymentSummary) {
          applySummary(payload.paymentSummary);
          if (
            !finalTotalDirtyRef.current &&
            editRevisionAtStart === finalTotalEditRevisionRef.current
          ) {
            setFinalTotal(
              payload.paymentSummary.jobTotalCents == null
                ? ""
                : (payload.paymentSummary.jobTotalCents / 100).toFixed(2),
            );
          }
        }
        setRows(Array.isArray(payload.payments) ? payload.payments : []);
        setLoaded(true);
      } else {
        const nextMessage = await errorMessage(
          response,
          "Unable to load payments.",
        );
        if (loadRevision === paymentLoadRevisionRef.current) {
          setMessage(nextMessage);
        }
      }
    } catch {
      if (loadRevision === paymentLoadRevisionRef.current) {
        setMessage("Unable to load payments. Check your connection and retry.");
      }
    } finally {
      if (loadRevision === paymentLoadRevisionRef.current) {
        setLoading(false);
      }
    }
  }, [appointmentId, applySummary]);

  const saveFinalTotal = async (): Promise<boolean> => {
    const finalTotalCents = centsFromDollars(finalTotal);
    if (finalTotalCents == null || finalTotalCents <= 0) {
      setMessage("Enter a final job total greater than $0.");
      return false;
    }
    if (
      summary.jobTotalCents === finalTotalCents &&
      summary.jobTotalCents !== null
    ) {
      finalTotalDirtyRef.current = false;
      return true;
    }
    ++paymentLoadRevisionRef.current;
    setLoading(false);
    try {
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/final-total`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            finalTotalCents,
            ...(changeReason.trim()
              ? { changeReason: changeReason.trim() }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        setMessage(
          await errorMessage(response, "Unable to save the final total."),
        );
        return false;
      }
      const nextSummary = {
        ...summary,
        jobTotalCents: finalTotalCents,
        balanceCents: Math.max(finalTotalCents - summary.paidTowardJobCents, 0),
      };
      finalTotalDirtyRef.current = false;
      applySummary(nextSummary);
      setFinalTotal((finalTotalCents / 100).toFixed(2));
      await load();
      router.refresh();
      return true;
    } catch {
      setMessage(
        "Unable to save the final total. Check your connection and retry.",
      );
      return false;
    }
  };

  const acceptSquare = async () => {
    if (!online) {
      setMessage("Payments are disabled offline.");
      return;
    }
    if (needsScope) {
      setMessage("Add the quoted-to-remove summary before taking payment.");
      return;
    }
    setBusy("square");
    setMessage(null);
    let handoffStarted = false;
    try {
      if (!(await saveFinalTotal())) return;
      const targetPlatform = platform();
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/payment-attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientRequestId: crypto.randomUUID(),
            platform: targetPlatform,
          }),
        },
      );
      if (!response.ok) {
        setMessage(await errorMessage(response, "Unable to open Square."));
        return;
      }
      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const launchUrl = payload?.["launchUrl"];
      if (typeof launchUrl !== "string" || !launchUrl) {
        setMessage("Square did not return a launch link.");
        return;
      }
      setMessage(
        "Opening Square. StonegateOS will verify the charge before showing Paid.",
      );
      openSquare(launchUrl, targetPlatform);
      handoffStarted = true;
    } catch {
      setMessage("Unable to open Square. Check your connection and retry.");
    } finally {
      if (!handoffStarted) setBusy(null);
    }
  };

  const recordManual = async () => {
    if (!online) {
      setMessage("Payments are disabled offline.");
      return;
    }
    if (needsScope) {
      setMessage("Add the quoted-to-remove summary before recording payment.");
      return;
    }
    setBusy("manual");
    setMessage(null);
    try {
      if (!(await saveFinalTotal())) return;
      const tipCents = manualTip.trim() ? centsFromDollars(manualTip) : 0;
      if (tipCents == null) {
        setMessage("Enter a valid tip or leave it blank.");
        return;
      }
      const response = await fetch(
        `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/manual-payments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientRequestId: crypto.randomUUID(),
            tenderType: manualTender,
            tipCents,
            ...(manualNote.trim() ? { note: manualNote.trim() } : {}),
          }),
        },
      );
      if (!response.ok) {
        setMessage(
          await errorMessage(response, "Unable to record the payment."),
        );
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        paymentSummary?: AppointmentPaymentSummary;
      } | null;
      if (payload?.paymentSummary) applySummary(payload.paymentSummary);
      setMessage(
        `${manualTender === "cash" ? "Cash" : "Check"} payment recorded. Job completion is still separate.`,
      );
      setManualTip("");
      setManualNote("");
      await load();
      router.refresh();
    } catch {
      setMessage(
        "Unable to record the payment. Check your connection and retry.",
      );
    } finally {
      setBusy(null);
    }
  };

  const balance = summary.balanceCents;
  const enteredFinalTotalCents = centsFromDollars(finalTotal);
  const hasRecordedPayment =
    summary.paidTowardJobCents > 0 ||
    summary.refundedCents > 0 ||
    ["partial", "paid", "refunded", "needs_review"].includes(summary.status);
  const canEditFinalTotal = isOwner || !hasRecordedPayment;
  const finalTotalIsDirty = enteredFinalTotalCents !== summary.jobTotalCents;
  const actionBalance =
    enteredFinalTotalCents != null && enteredFinalTotalCents > 0
      ? Math.max(enteredFinalTotalCents - summary.paidTowardJobCents, 0)
      : balance;
  const canStartPayment =
    canCollect &&
    ledgerAvailable &&
    online &&
    !needsScope &&
    actionBalance != null &&
    actionBalance > 0 &&
    summary.status !== "needs_review";
  const saveFinalTotalOnly = async () => {
    if (!online) {
      setMessage("Payments are disabled offline.");
      return;
    }
    setBusy("total");
    setMessage(null);
    try {
      const saved = await saveFinalTotal();
      if (saved) {
        setChangeReason("");
        setMessage("Final job total saved.");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <details
      className="rounded-md border border-white/10 bg-slate-950 p-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded) void load();
      }}
    >
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Payment</p>
            <p className="mt-0.5 text-xs text-slate-400">
              {ledgerAvailable
                ? balance == null
                  ? "Final total not set"
                  : `${formatMoney(balance)} remaining`
                : summary.jobTotalCents == null
                  ? "Final total not set"
                  : `Final total ${formatMoney(summary.jobTotalCents)}`}
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(summary.status)}`}
          >
            {ledgerAvailable ? statusLabel(summary.status) : "Not enabled"}
          </span>
        </div>
      </summary>

      <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
        {!online ? (
          <p className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
            Payments are disabled offline.
          </p>
        ) : null}
        {needsScope ? (
          <p className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
            Add the quoted-to-remove summary before accepting payment.
          </p>
        ) : null}
        {summary.status === "needs_review" ? (
          <p className="rounded-md border border-rose-300/30 bg-rose-300/10 p-3 text-sm text-rose-100">
            This payment needs owner review before another charge is attempted.
          </p>
        ) : null}
        {message ? (
          <p
            role="status"
            className="rounded-md border border-cyan-300/20 bg-cyan-300/10 p-3 text-sm leading-5 text-cyan-100"
          >
            {message}
          </p>
        ) : null}

        <div className="rounded-md border border-white/10 bg-slate-900 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400">
              {ledgerAvailable ? "Balance" : "Final job total"}
            </span>
            <span className="text-base font-semibold text-white">
              {formatMoney(
                ledgerAvailable ? summary.balanceCents : summary.jobTotalCents,
              )}
            </span>
          </div>
          {ledgerAvailable ? (
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">Final job total</span>
              <span className="font-semibold text-slate-300">
                {formatMoney(summary.jobTotalCents)}
              </span>
            </div>
          ) : null}
          {summary.paidTowardJobCents > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">Paid toward job</span>
              <span className="font-semibold text-emerald-200">
                {formatMoney(summary.paidTowardJobCents)}
              </span>
            </div>
          ) : null}
          {summary.tipCents > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">Tips</span>
              <span className="font-semibold text-slate-300">
                {formatMoney(summary.tipCents)}
              </span>
            </div>
          ) : null}
          {summary.refundedCents > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">Refunded</span>
              <span className="font-semibold text-amber-200">
                {formatMoney(summary.refundedCents)}
              </span>
            </div>
          ) : null}
        </div>

        {canCollect ? (
          <>
            {summary.jobTotalCents == null ? (
              <label className="block">
                <span className="text-xs font-semibold text-slate-300">
                  Set final job total
                </span>
                <div className="mt-1 flex items-center rounded-md border border-white/10 bg-slate-900 focus-within:border-cyan-300">
                  <span className="pl-3 text-slate-400">$</span>
                  <input
                    value={finalTotal}
                    onChange={(event) => {
                      finalTotalDirtyRef.current = true;
                      finalTotalEditRevisionRef.current += 1;
                      setFinalTotal(event.target.value);
                    }}
                    inputMode="decimal"
                    disabled={busy !== null || Boolean(summary.activeAttemptId)}
                    className="min-w-0 flex-1 bg-transparent px-2 py-3 text-base text-white outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                    placeholder="350.00"
                  />
                </div>
              </label>
            ) : canEditFinalTotal ? (
              <details className="rounded-md border border-white/10 bg-slate-900 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                  Edit final job total
                </summary>
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-300">
                      Final job total
                    </span>
                    <div className="mt-1 flex items-center rounded-md border border-white/10 bg-slate-950 focus-within:border-cyan-300">
                      <span className="pl-3 text-slate-400">$</span>
                      <input
                        value={finalTotal}
                        onChange={(event) => {
                          finalTotalDirtyRef.current = true;
                          finalTotalEditRevisionRef.current += 1;
                          setFinalTotal(event.target.value);
                        }}
                        inputMode="decimal"
                        disabled={
                          busy !== null || Boolean(summary.activeAttemptId)
                        }
                        className="min-w-0 flex-1 bg-transparent px-2 py-3 text-base text-white outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                        placeholder="350.00"
                      />
                    </div>
                  </label>
                  {hasRecordedPayment && isOwner ? (
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">
                        Reason for total change
                      </span>
                      <input
                        value={changeReason}
                        onChange={(event) =>
                          setChangeReason(event.target.value)
                        }
                        maxLength={500}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white"
                        placeholder="Required if changing a paid job"
                      />
                    </label>
                  ) : null}
                  {summary.activeAttemptId ? (
                    <p className="text-xs leading-5 text-amber-100">
                      The final total is locked while this Square attempt is
                      active.
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}

            {canEditFinalTotal ? (
              <button
                type="button"
                disabled={
                  !online ||
                  busy !== null ||
                  Boolean(summary.activeAttemptId) ||
                  !finalTotalIsDirty
                }
                onClick={() => void saveFinalTotalOnly()}
                className="w-full rounded-md border border-cyan-300/40 bg-cyan-300/10 px-3 py-3 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "total"
                  ? "Saving final job total…"
                  : finalTotalIsDirty
                    ? "Save final job total"
                    : "Final job total saved"}
              </button>
            ) : null}

            {ledgerAvailable ? (
              <>
                <button
                  type="button"
                  disabled={!canStartPayment || busy !== null}
                  onClick={() => void acceptSquare()}
                  className="w-full rounded-md bg-emerald-300 px-3 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "square"
                    ? "Opening Square…"
                    : summary.activeAttemptId
                      ? "Resume payment in Square"
                      : `Accept payment${
                          typeof actionBalance === "number" && actionBalance > 0
                            ? ` · ${formatMoney(actionBalance)}`
                            : ""
                        }`}
                </button>
                <p className="text-xs leading-5 text-slate-400">
                  Square opens on this phone for Tap to Pay, tip, and receipt. A
                  return from Square is provisional until StonegateOS verifies
                  the provider payment.
                </p>

                <details className="rounded-md border border-white/10 bg-slate-900 p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                    Record cash or check
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      {(["cash", "check"] as const).map((tender) => (
                        <button
                          key={tender}
                          type="button"
                          onClick={() => setManualTender(tender)}
                          className={`rounded-md border px-3 py-2 text-sm font-semibold capitalize ${
                            manualTender === tender
                              ? "border-cyan-300 bg-cyan-300 text-slate-950"
                              : "border-white/10 bg-slate-950 text-slate-200"
                          }`}
                        >
                          {tender}
                        </button>
                      ))}
                    </div>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">
                        Tip (optional)
                      </span>
                      <div className="mt-1 flex items-center rounded-md border border-white/10 bg-slate-950">
                        <span className="pl-3 text-slate-400">$</span>
                        <input
                          value={manualTip}
                          onChange={(event) => setManualTip(event.target.value)}
                          inputMode="decimal"
                          className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base text-white outline-none"
                          placeholder="0.00"
                        />
                      </div>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">
                        Note (optional)
                      </span>
                      <input
                        value={manualNote}
                        onChange={(event) => setManualNote(event.target.value)}
                        maxLength={500}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white"
                        placeholder="Check number"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!canStartPayment || busy !== null}
                      onClick={() => void recordManual()}
                      className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                    >
                      {busy === "manual"
                        ? "Recording…"
                        : `Record full ${manualTender} balance`}
                    </button>
                  </div>
                </details>
              </>
            ) : (
              <p className="rounded-md border border-slate-700 bg-slate-900 p-3 text-xs leading-5 text-slate-300">
                Payment collection is not enabled yet. You can still save the
                correct final job total for commissions and payouts.
              </p>
            )}
          </>
        ) : null}

        {summary.latestReceiptUrl ? (
          <a
            href={summary.latestReceiptUrl}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-cyan-100"
          >
            Open latest receipt
          </a>
        ) : null}

        {loading ? (
          <p className="text-sm text-slate-400">Loading payment history…</p>
        ) : rows.length ? (
          <details className="rounded-md border border-white/10 bg-slate-900 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-200">
              Payment history ({rows.length})
            </summary>
            <div className="mt-3 space-y-2">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="rounded-md border border-white/10 bg-slate-950 p-3 text-xs"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold capitalize text-slate-200">
                        {row.legacySource
                          ? "Paid (legacy)"
                          : row.tenderType || row.provider || "Payment"}
                      </p>
                      <p className="mt-1 text-slate-400">
                        {row.cardBrand
                          ? `${row.cardBrand}${row.last4 ? ` •••• ${row.last4}` : ""}`
                          : row.canonicalStatus || "Unknown"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-slate-100">
                        {formatMoney(row.jobAmountCents)}
                      </p>
                      {row.tipCents ? (
                        <p className="mt-1 text-slate-400">
                          Tip {formatMoney(row.tipCents)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {row.receiptUrl ? (
                    <a
                      href={row.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 block font-semibold text-cyan-100"
                    >
                      Receipt
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : loaded ? (
          <p className="text-xs text-slate-500">No payments recorded.</p>
        ) : null}

        <p className="text-xs leading-5 text-slate-500">
          Payment and job completion are separate. Mark the job complete only
          when the removal work is actually finished.
        </p>
      </div>
    </details>
  );
}
