"use client";
import { useRef, useState, type FormEvent } from "react";
import { formEntryText } from "@/lib/form-entry-text";
import {
  loadPartnerAllocationReconciliation,
  savePartnerAllocationReconciliation,
  type AllocationReconciliationView,
} from "../actions/partner-allocation-reconciliation";
const INPUT =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700";
const BUTTON =
  "min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50";
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
const dollars = (value: number) => (value / 100).toFixed(2);
function cents(value: FormDataEntryValue | null) {
  const text = formEntryText(value).trim();
  if (!/^\d{1,8}(?:\.\d{1,2})?$/u.test(text))
    throw new Error("Use dollar amounts with at most two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
type Row = { key: string; invoiceId: string; gross: number };
type AllocationCommand = {
  payments: {
    paymentId: string;
    allocations: {
      invoiceId: string;
      grossAmountCents: number;
      refunds: { refundId: string; amountCents: number }[];
    }[];
  }[];
  historicalPayments?: {
    paymentId: string;
    tenderType: "cash" | "check";
    jobAmountCents: number;
    receivedAt: string;
    evidenceReference: string;
    tipAcknowledgment: "NO_UNRECORDED_TIP";
    allocations: { invoiceId: string; grossAmountCents: number; refunds: [] }[];
  }[];
  reason: string;
  evidenceReference: string;
};
export function PartnerAllocationReconciliation({
  accountId,
  jobId,
  canManage,
}: {
  accountId: string;
  jobId: string;
  canManage: boolean;
}) {
  const [data, setData] = useState<AllocationReconciliationView | null>(null);
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [historicalRows, setHistoricalRows] = useState<
    { id: string; rows: Row[] }[]
  >([]);
  const [prepared, setPrepared] = useState<{
    command: AllocationCommand;
    revision: string;
    totals: { name: string; before: number; after: number }[];
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const saving = useRef(false),
    keys = useRef(new Map<string, string>());
  async function load() {
    if (saving.current) return;
    setBusy(true);
    try {
      const result = await loadPartnerAllocationReconciliation(
        accountId,
        jobId,
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setData(result.data);
      setPrepared(null);
      setHistoricalRows([]);
      setRows(
        Object.fromEntries(
          result.data.payments.map((payment) => {
            const existing = result.data.allocations.filter(
              (row) => row.paymentId === payment.id && row.state === "settled",
            );
            return [
              payment.id,
              existing.length
                ? existing.map((row) => ({
                    key: row.id,
                    invoiceId: row.partnerInvoiceId,
                    gross: row.amountCents,
                  }))
                : [
                    {
                      key: crypto.randomUUID(),
                      invoiceId: "",
                      gross: payment.jobAmountCents ?? 0,
                    },
                  ],
            ];
          }),
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || saving.current) return;
    const values = new FormData(event.currentTarget);
    try {
      const payments = data.payments
        .filter((payment) => values.get(`include-${payment.id}`) === "on")
        .map((payment) => {
          const completedRefunds = data.refunds.filter(
            (refund) =>
              refund.paymentId === payment.id && refund.status === "completed",
          );
          return {
            paymentId: payment.id,
            allocations: (rows[payment.id] ?? []).map((row) => ({
              invoiceId: formEntryText(values.get(`invoice-${row.key}`)),
              grossAmountCents: cents(values.get(`gross-${row.key}`)),
              refunds: completedRefunds
                .map((refund) => ({
                  refundId: refund.id,
                  amountCents: cents(
                    values.get(`refund-${row.key}-${refund.id}`),
                  ),
                }))
                .filter((refund) => refund.amountCents > 0),
            })),
          };
        });
      const historicalPayments = historicalRows.map<NonNullable<AllocationCommand["historicalPayments"]>[number]>((record) => {
        const tenderType = formEntryText(values.get(`historic-method-${record.id}`));
        if (tenderType !== "cash" && tenderType !== "check")
          throw new Error(
            "Choose the actual historical cash or check payment method.",
          );
        const received = new Date(
          formEntryText(values.get(`historic-date-${record.id}`)),
        );
        if (
          !Number.isFinite(received.getTime()) ||
          received.getTime() > Date.now()
        )
          throw new Error(
            "Enter the actual receipt date and time, not a future date.",
          );
        if (values.get(`historic-tip-${record.id}`) !== "on")
          throw new Error(
            "Resolve any unrecorded receipt tip with payroll before claiming this receipt is reconciled.",
          );
        return {
          paymentId: record.id,
          tenderType,
          jobAmountCents: cents(values.get(`historic-amount-${record.id}`)),
          receivedAt: received.toISOString(),
          evidenceReference: formEntryText(
            values.get(`historic-evidence-${record.id}`),
          ),
          tipAcknowledgment: "NO_UNRECORDED_TIP" as const,
          allocations: record.rows.map((row) => ({
            invoiceId: formEntryText(values.get(`historic-invoice-${row.key}`)),
            grossAmountCents: cents(values.get(`historic-gross-${row.key}`)),
            refunds: [] as [],
          })),
        };
      });
      if (!payments.length && !historicalPayments.length)
        throw new Error(
          "Select a genuine payment or enter a verified missing historical receipt.",
        );
      for (const record of historicalPayments) {
        if (
          record.jobAmountCents <= 0 ||
          record.allocations.some(
            (row) => !row.invoiceId || row.grossAmountCents <= 0,
          ) ||
          new Set(record.allocations.map((row) => row.invoiceId)).size !==
            record.allocations.length ||
          record.allocations.reduce(
            (sum, row) => sum + row.grossAmountCents,
            0,
          ) !== record.jobAmountCents
        )
          throw new Error(
            "Allocate each historical receipt’s service principal exactly once across chosen invoices.",
          );
      }
      if (
        historicalPayments.reduce((sum, row) => sum + row.jobAmountCents, 0) >
        data.unexplainedPaidPrincipalCents
      )
        throw new Error(
          "Historical receipts cannot exceed the unexplained legacy paid principal. Do not record existing payments again.",
        );
      const command: AllocationCommand = {
        payments,
        ...(historicalPayments.length ? { historicalPayments } : {}),
        reason: formEntryText(values.get("reason")),
        evidenceReference: formEntryText(values.get("evidence")),
      };
      for (const plan of payments) {
        const payment = data.payments.find((row) => row.id === plan.paymentId)!;
        if (
          plan.allocations.some(
            (row) => !row.invoiceId || row.grossAmountCents <= 0,
          ) ||
          new Set(plan.allocations.map((row) => row.invoiceId)).size !==
            plan.allocations.length
        )
          throw new Error(
            "Choose each invoice once and enter its allocated amount.",
          );
        if (
          plan.allocations.reduce(
            (sum, row) => sum + row.grossAmountCents,
            0,
          ) !== payment.jobAmountCents
        )
          throw new Error(
            "The invoice allocations must equal the payment’s service principal exactly. Exclude tips.",
          );
        for (const refund of data.refunds.filter(
          (row) =>
            row.paymentId === plan.paymentId && row.status === "completed",
        ))
          if (
            plan.allocations
              .flatMap((row) => row.refunds)
              .filter((row) => row.refundId === refund.id)
              .reduce((sum, row) => sum + row.amountCents, 0) !==
            refund.jobAmountCents
          )
            throw new Error(
              "Allocate each completed service refund exactly once across the invoices.",
            );
      }
      const selected = new Set(payments.map((row) => row.paymentId));
      const selectedRefunds = new Set(
        data.refunds
          .filter((row) => selected.has(row.paymentId))
          .map((row) => row.id),
      );
      setPrepared({
        command,
        revision: data.revision,
        totals: data.invoices.map((invoice) => ({
          name: invoice.number,
          before: invoice.paidCents,
          after:
            data.allocations
              .filter(
                (row) =>
                  row.partnerInvoiceId === invoice.id &&
                  row.state === "settled" &&
                  !selected.has(row.paymentId),
              )
              .reduce((sum, row) => sum + row.amountCents, 0) -
            data.refundAllocations
              .filter(
                (row) =>
                  row.partnerInvoiceId === invoice.id &&
                  !selectedRefunds.has(row.refundId),
              )
              .reduce((sum, row) => sum + row.jobAmountCents, 0) +
            [...payments, ...historicalPayments]
              .flatMap((row) => row.allocations)
              .filter((row) => row.invoiceId === invoice.id)
              .reduce(
                (sum, row) =>
                  sum +
                  row.grossAmountCents -
                  row.refunds.reduce(
                    (total, refund) => total + refund.amountCents,
                    0,
                  ),
                0,
              ),
        })),
      });
      setMessage(
        "Review the complete before-and-after allocation before recording it. No money has moved.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Review every allocation.",
      );
    }
  }
  async function commit() {
    if (!prepared || saving.current) return;
    try {
      const { command, revision } = prepared;
      const signature = JSON.stringify({ revision, command });
      const key = keys.current.get(signature) ?? crypto.randomUUID();
      keys.current.set(signature, key);
      saving.current = true;
      setBusy(true);
      const result = await savePartnerAllocationReconciliation(
        accountId,
        jobId,
        revision,
        command,
        key,
      );
      setMessage(result.message);
      if (result.ok) {
        keys.current.delete(signature);
        saving.current = false;
        await load();
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Review every allocation.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="border-t border-slate-200 pt-3">
      <summary className="min-h-11 cursor-pointer py-3 font-medium">
        Reconcile existing payment allocations
      </summary>
      <p className="text-sm text-slate-600">
        Correct an existing payment’s invoice allocation or record a verified
        missing historical cash/check receipt. This is not a new collection; it
        does not issue refunds, change job prices, or change payroll.
      </p>
      <button
        className={`${BUTTON} my-3`}
        disabled={busy}
        onClick={() => void load()}
      >
        {data
          ? "Refresh reconciliation records"
          : "Load payment and invoice evidence"}
      </button>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
      {data && (
        <>
          <ul className="my-3 space-y-2 text-sm">
            {data.invoices.map((invoice) => (
              <li key={invoice.id}>
                <strong>{invoice.number}</strong>:{" "}
                {invoice.status.replaceAll("_", " ")} ·{" "}
                {money(invoice.totalCents)} total · {money(invoice.paidCents)}{" "}
                paid · {money(invoice.balanceCents)} due
              </li>
            ))}
          </ul>
          {data.blockers.map((blocker) => (
            <p
              key={blocker}
              className="my-2 rounded-lg bg-amber-50 p-3 text-sm"
            >
              {blocker}
            </p>
          ))}
          <form
            onSubmit={submit}
            hidden={Boolean(prepared)}
            className="space-y-4"
            key={data.revision}
          >
            {canManage && data.unexplainedPaidPrincipalCents > 0 && (
              <section
                className="space-y-3 border-t border-slate-200 pt-3"
                aria-label="Missing historical receipts"
              >
                <h5 className="font-semibold">
                  Verified missing historical cash/check receipts
                </h5>
                <p className="text-sm">
                  Up to {money(data.unexplainedPaidPrincipalCents)} of the
                  existing paid balance lacks a canonical payment record. Do not
                  collect it again. Use original dated receipts only; amounts
                  are service principal, not tips.
                </p>
                <p className="text-sm">
                  If a receipt includes an unrecorded tip, stop and arrange
                  payroll review. This form cannot reconcile that receipt or
                  alter tip payouts.
                </p>
                {historicalRows.map((record) => (
                  <fieldset
                    key={record.id}
                    disabled={busy || !!data.blockers.length}
                    className="space-y-3 rounded-lg border border-slate-300 p-3"
                  >
                    <legend className="px-1 font-medium">
                      Historical receipt — no new money collected
                    </legend>
                    <label className="block text-sm">
                      Original payment method
                      <select
                        required
                        className={INPUT}
                        name={`historic-method-${record.id}`}
                        defaultValue=""
                      >
                        <option value="">Choose cash or check</option>
                        <option value="cash">Cash</option>
                        <option value="check">Check</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      Original service principal ($)
                      <input
                        required
                        inputMode="decimal"
                        className={INPUT}
                        name={`historic-amount-${record.id}`}
                      />
                    </label>
                    <label className="block text-sm">
                      Receipt date and time (your local time)
                      <input
                        required
                        type="datetime-local"
                        className={INPUT}
                        name={`historic-date-${record.id}`}
                      />
                    </label>
                    <label className="block text-sm">
                      Original receipt or check reference
                      <input
                        required
                        minLength={3}
                        maxLength={500}
                        className={INPUT}
                        name={`historic-evidence-${record.id}`}
                      />
                    </label>
                    {record.rows.map((row) => (
                      <div
                        key={row.key}
                        className="space-y-2 border-t border-slate-200 pt-2"
                      >
                        <label className="block text-sm">
                          Apply historical principal to invoice
                          <select
                            required
                            className={INPUT}
                            name={`historic-invoice-${row.key}`}
                            defaultValue=""
                          >
                            <option value="">Choose an invoice</option>
                            {data.invoices
                              .filter((invoice) =>
                                [
                                  "issued",
                                  "partially_paid",
                                  "paid",
                                  "overdue",
                                ].includes(invoice.status),
                              )
                              .map((invoice) => (
                                <option key={invoice.id} value={invoice.id}>
                                  {invoice.number}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="block text-sm">
                          Historical principal allocated ($)
                          <input
                            required
                            inputMode="decimal"
                            className={INPUT}
                            name={`historic-gross-${row.key}`}
                          />
                        </label>
                        {record.rows.length > 1 && (
                          <button
                            type="button"
                            className={BUTTON}
                            onClick={() =>
                              setHistoricalRows((current) =>
                                current.map((item) =>
                                  item.id === record.id
                                    ? {
                                        ...item,
                                        rows: item.rows.filter(
                                          (part) => part.key !== row.key,
                                        ),
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            Remove historical allocation row
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() =>
                        setHistoricalRows((current) =>
                          current.map((item) =>
                            item.id === record.id
                              ? {
                                  ...item,
                                  rows: [
                                    ...item.rows,
                                    {
                                      key: crypto.randomUUID(),
                                      invoiceId: "",
                                      gross: 0,
                                    },
                                  ],
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      Split historical receipt between invoices
                    </button>
                    <label className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        required
                        type="checkbox"
                        name={`historic-tip-${record.id}`}
                        className="h-5 w-5"
                      />
                      I verified the receipt has no unrecorded tip. Any tip is
                      already separately recorded; otherwise I must stop for
                      payroll review.
                    </label>
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() =>
                        setHistoricalRows((current) =>
                          current.filter((item) => item.id !== record.id),
                        )
                      }
                    >
                      Remove historical receipt
                    </button>
                  </fieldset>
                ))}
                <button
                  type="button"
                  className={BUTTON}
                  disabled={
                    busy ||
                    !!data.blockers.length ||
                    historicalRows.length >= 10
                  }
                  onClick={() =>
                    setHistoricalRows((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        rows: [
                          { key: crypto.randomUUID(), invoiceId: "", gross: 0 },
                        ],
                      },
                    ])
                  }
                >
                  Add verified historical receipt
                </button>
              </section>
            )}
            {data.payments.map((payment) => (
              <fieldset
                key={payment.id}
                disabled={
                  !canManage ||
                  busy ||
                  payment.status !== "completed" ||
                  !!data.blockers.length
                }
                className="space-y-3 rounded-lg border border-slate-200 p-3"
              >
                <legend className="px-1 text-sm font-semibold">
                  {payment.method ?? "Payment"} ·{" "}
                  {money(payment.jobAmountCents ?? 0)} service principal ·{" "}
                  {payment.status}
                </legend>
                <p className="break-all text-xs text-slate-600">
                  Payment record {payment.id} ·{" "}
                  {new Date(
                    payment.capturedAt ?? payment.createdAt,
                  ).toLocaleDateString()}{" "}
                  · {money(payment.tipCents)} tips excluded
                </p>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    name={`include-${payment.id}`}
                    className="h-5 w-5"
                  />
                  Reconcile this payment using the supporting records
                </label>
                {(rows[payment.id] ?? []).map((row) => (
                  <div
                    key={row.key}
                    className="space-y-2 border-t border-slate-100 pt-3"
                  >
                    <label className="block text-sm">
                      Apply to invoice
                      <select
                        className={INPUT}
                        name={`invoice-${row.key}`}
                        defaultValue={row.invoiceId}
                      >
                        <option value="">Choose an invoice</option>
                        {data.invoices
                          .filter((invoice) =>
                            [
                              "issued",
                              "partially_paid",
                              "paid",
                              "overdue",
                            ].includes(invoice.status),
                          )
                          .map((invoice) => (
                            <option key={invoice.id} value={invoice.id}>
                              {invoice.number} · {money(invoice.totalCents)}{" "}
                              total
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      Original service payment applied ($)
                      <input
                        className={INPUT}
                        name={`gross-${row.key}`}
                        inputMode="decimal"
                        defaultValue={dollars(row.gross)}
                      />
                    </label>
                    {data.refunds
                      .filter(
                        (refund) =>
                          refund.paymentId === payment.id &&
                          refund.status === "completed",
                      )
                      .map((refund) => (
                        <label key={refund.id} className="block text-sm">
                          Completed refund {refund.id.slice(0, 8)}:{" "}
                          {money(refund.jobAmountCents)} service principal —
                          amount belonging to this invoice ($)
                          <input
                            className={INPUT}
                            inputMode="decimal"
                            name={`refund-${row.key}-${refund.id}`}
                            defaultValue={dollars(
                              data.refundAllocations.find(
                                (split) =>
                                  split.refundId === refund.id &&
                                  split.partnerInvoiceId === row.invoiceId,
                              )?.jobAmountCents ?? 0,
                            )}
                          />
                        </label>
                      ))}
                    {(rows[payment.id]?.length ?? 0) > 1 && (
                      <button
                        type="button"
                        className={BUTTON}
                        onClick={() =>
                          setRows((current) => ({
                            ...current,
                            [payment.id]: current[payment.id]!.filter(
                              (item) => item.key !== row.key,
                            ),
                          }))
                        }
                      >
                        Remove allocation row
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() =>
                    setRows((current) => ({
                      ...current,
                      [payment.id]: [
                        ...(current[payment.id] ?? []),
                        { key: crypto.randomUUID(), invoiceId: "", gross: 0 },
                      ],
                    }))
                  }
                >
                  Split between another invoice
                </button>
              </fieldset>
            ))}
            {canManage &&
              (data.payments.length > 0 || historicalRows.length > 0) && (
                <fieldset
                  disabled={busy || !!data.blockers.length}
                  className="space-y-3"
                >
                  <label className="block text-sm">
                    Supporting receipt or reconciliation reference
                    <input
                      className={INPUT}
                      name="evidence"
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </label>
                  <label className="block text-sm">
                    Why these allocations are correct
                    <textarea
                      className={INPUT}
                      name="reason"
                      required
                      minLength={12}
                      maxLength={2000}
                    />
                  </label>
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <input type="checkbox" required className="h-5 w-5" />I
                    checked the original payment and refund records. No missing
                    payment is being assumed or erased.
                  </label>
                  <button
                    className={`${BUTTON} bg-emerald-800 text-white`}
                    type="submit"
                  >
                    Review reconciliation
                  </button>
                </fieldset>
              )}
          </form>
          {prepared && (
            <section
              aria-label="Reconciliation review"
              className="my-4 space-y-3 rounded-lg border border-slate-300 p-4"
            >
              <h5 className="font-semibold">
                Review payment allocation changes
              </h5>
              <p className="text-sm">
                {prepared.command.payments.length} existing payment records. No
                new charges, refunds, job revenue, or payroll changes.
              </p>
              {prepared.command.historicalPayments?.map((record) => (
                <p key={record.paymentId} className="text-sm">
                  Historical {record.tenderType}: {money(record.jobAmountCents)}{" "}
                  service principal received{" "}
                  {new Date(record.receivedAt).toLocaleString()} · original
                  reference {record.evidenceReference}. No tip is being recorded
                  and no money is being collected.
                </p>
              ))}
              <ul className="space-y-2 text-sm">
                {prepared.totals.map((row) => (
                  <li key={row.name}>
                    {row.name}: net paid {money(row.before)} →{" "}
                    {money(row.after)}
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                Evidence: {prepared.command.evidenceReference}
              </p>
              <p className="text-sm">Reason: {prepared.command.reason}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  type="button"
                  className={BUTTON}
                  onClick={() => setPrepared(null)}
                >
                  Edit allocations
                </button>
                <button
                  disabled={busy}
                  type="button"
                  className={`${BUTTON} bg-emerald-800 text-white`}
                  onClick={() => void commit()}
                >
                  Record audited reconciliation
                </button>
              </div>
            </section>
          )}
          {!data.payments.length && (
            <p className="text-sm">
              No canonical payment records exist for this job. A paid balance
              cannot be repaired by inventing an allocation. Use the historical
              receipt form only when original cash/check evidence supports it;
              missing provider payments require provider reconciliation.
            </p>
          )}
          <details className="mt-4">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
              Reconciliation history ({data.history.length})
            </summary>
            <ul className="space-y-3 text-sm">
              {data.history.map((item) => (
                <li key={item.id}>
                  <p>
                    {new Date(item.createdAt).toLocaleString()} — {item.reason}
                  </p>
                  <p>Evidence: {item.evidenceReference}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </details>
  );
}
