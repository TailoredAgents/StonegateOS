"use client";

import * as React from "react";
import type { OfflinePaymentSummary } from "./lib/offline-media";

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

function openSquare(launchUrl: string, targetPlatform: "ios" | "android"): void {
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
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const candidate = payload?.["message"] ?? payload?.["error"];
  if (typeof candidate === "string" && candidate.trim()) {
    const code = candidate.trim();
    const messages: Record<string, string> = {
      square_pos_disabled: "Square Tap to Pay is not enabled yet.",
      square_not_configured: "Square setup is incomplete. Ask the owner.",
      quoted_scope_required:
        "Add the quoted-to-remove summary before taking payment.",
      appointment_already_paid: "This appointment is already paid.",
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
  canCollect,
  isOwner,
  needsScope,
}: {
  appointmentId: string;
  initialSummary: AppointmentPaymentSummary;
  canCollect: boolean;
  isOwner: boolean;
  needsScope: boolean;
}) {
  const [summary, setSummary] = React.useState(initialSummary);
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
    setLoading(true);
    const response = await fetch(
      `/api/mobile/appointments/${encodeURIComponent(appointmentId)}/payments`,
      { cache: "no-store" },
    );
    if (response.ok) {
      const payload = (await response.json()) as PaymentsResponse;
      if (payload.paymentSummary) {
        setSummary(payload.paymentSummary);
        setFinalTotal(
          payload.paymentSummary.jobTotalCents == null
            ? ""
            : (payload.paymentSummary.jobTotalCents / 100).toFixed(2),
        );
      }
      setRows(Array.isArray(payload.payments) ? payload.payments : []);
      setLoaded(true);
    } else {
      setMessage(await errorMessage(response, "Unable to load payments."));
    }
    setLoading(false);
  }, [appointmentId]);

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
      return true;
    }
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
      setMessage(await errorMessage(response, "Unable to save the final total."));
      return false;
    }
    setSummary((current) => ({
      ...current,
      jobTotalCents: finalTotalCents,
      balanceCents: Math.max(
        finalTotalCents - current.paidTowardJobCents,
        0,
      ),
      status:
        current.paidTowardJobCents === 0
          ? "unpaid"
          : current.paidTowardJobCents >= finalTotalCents
            ? "paid"
            : "partial",
    }));
    return true;
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
    if (!(await saveFinalTotal())) {
      setBusy(null);
      return;
    }
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
      setBusy(null);
      return;
    }
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const launchUrl = payload?.["launchUrl"];
    if (typeof launchUrl !== "string" || !launchUrl) {
      setMessage("Square did not return a launch link.");
      setBusy(null);
      return;
    }
    setMessage(
      "Opening Square. StonegateOS will verify the charge before showing Paid.",
    );
    openSquare(launchUrl, targetPlatform);
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
    if (!(await saveFinalTotal())) {
      setBusy(null);
      return;
    }
    const tipCents = manualTip.trim()
      ? centsFromDollars(manualTip)
      : 0;
    if (tipCents == null) {
      setMessage("Enter a valid tip or leave it blank.");
      setBusy(null);
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
    } else {
      const payload = (await response.json().catch(() => null)) as
        | { paymentSummary?: AppointmentPaymentSummary }
        | null;
      if (payload?.paymentSummary) setSummary(payload.paymentSummary);
      setMessage(
        `${manualTender === "cash" ? "Cash" : "Check"} payment recorded. Job completion is still separate.`,
      );
      setManualTip("");
      setManualNote("");
      await load();
    }
    setBusy(null);
  };

  const balance = summary.balanceCents;
  const enteredFinalTotalCents = centsFromDollars(finalTotal);
  const actionBalance =
    enteredFinalTotalCents != null && enteredFinalTotalCents > 0
      ? Math.max(
          enteredFinalTotalCents - summary.paidTowardJobCents,
          0,
        )
      : balance;
  const canStartPayment =
    canCollect &&
    online &&
    !needsScope &&
    actionBalance != null &&
    actionBalance > 0 &&
    summary.status !== "needs_review";

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
              {balance == null
                ? "Final total not set"
                : `${formatMoney(balance)} remaining`}
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(summary.status)}`}
          >
            {statusLabel(summary.status)}
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

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md border border-white/10 bg-slate-900 p-3">
            <p className="text-xs text-slate-400">Final job total</p>
            <p className="mt-1 font-semibold">
              {formatMoney(summary.jobTotalCents)}
            </p>
          </div>
          <div className="rounded-md border border-white/10 bg-slate-900 p-3">
            <p className="text-xs text-slate-400">Paid toward job</p>
            <p className="mt-1 font-semibold">
              {formatMoney(summary.paidTowardJobCents)}
            </p>
          </div>
          <div className="rounded-md border border-white/10 bg-slate-900 p-3">
            <p className="text-xs text-slate-400">Tips</p>
            <p className="mt-1 font-semibold">
              {formatMoney(summary.tipCents)}
            </p>
          </div>
          <div className="rounded-md border border-white/10 bg-slate-900 p-3">
            <p className="text-xs text-slate-400">Refunded</p>
            <p className="mt-1 font-semibold">
              {formatMoney(summary.refundedCents)}
            </p>
          </div>
        </div>

        {canCollect ? (
          <>
            <label className="block">
              <span className="text-xs font-semibold text-slate-300">
                Final job total
              </span>
              <div className="mt-1 flex items-center rounded-md border border-white/10 bg-slate-900 focus-within:border-cyan-300">
                <span className="pl-3 text-slate-400">$</span>
                <input
                  value={finalTotal}
                  onChange={(event) => setFinalTotal(event.target.value)}
                  inputMode="decimal"
                  disabled={Boolean(summary.activeAttemptId)}
                  className="min-w-0 flex-1 bg-transparent px-2 py-3 text-base text-white outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                  placeholder="350.00"
                />
              </div>
            </label>
            {summary.activeAttemptId ? (
              <p className="text-xs leading-5 text-amber-100">
                The final total is locked while this Square attempt is active.
              </p>
            ) : null}
            {summary.paidTowardJobCents > 0 && isOwner ? (
              <label className="block">
                <span className="text-xs font-semibold text-slate-300">
                  Reason for total change
                </span>
                <input
                  value={changeReason}
                  onChange={(event) => setChangeReason(event.target.value)}
                  maxLength={500}
                  className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white"
                  placeholder="Required if changing a paid job"
                />
              </label>
            ) : null}
            {summary.paidTowardJobCents > 0 && !isOwner ? (
              <p className="text-xs leading-5 text-slate-400">
                Only an owner can change the final total after the first
                successful payment.
              </p>
            ) : null}

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
              return from Square is provisional until StonegateOS verifies the
              provider payment.
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
