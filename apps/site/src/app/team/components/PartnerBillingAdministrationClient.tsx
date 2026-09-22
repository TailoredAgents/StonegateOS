"use client";
import {
  partnerInvoiceRowsForJob,
  type PartnerInvoiceDraftRow,
} from "../lib/partner-invoice-lines";
import { useRef, useState, type FormEvent } from "react";
import { formEntryText } from "@/lib/form-entry-text";
import {
  getStaffBillingDocument,
  loadPartnerBillingAdministration,
  savePartnerBillingCommand,
  type BillingAdministrationData,
  type BillingInvoice,
} from "../actions/partner-billing";
import { PartnerBillingHistory } from "./PartnerBillingHistory";
import { PartnerAllocationReconciliation } from "./PartnerAllocationReconciliation";

const INPUT =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700";
const BUTTON =
  "min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50";
const PRIMARY = `${BUTTON} border-emerald-800 bg-emerald-800 text-white`;
function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value / 100);
}
function cents(value: FormDataEntryValue | null): number {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]{1,8}(?:\.[0-9]{1,2})?$/u.test(text))
    throw new Error(
      "Use a positive dollar amount with at most two decimal places.",
    );
  const [whole, fractional = ""] = text.split(".");
  const amount = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > 2_147_483_647)
    throw new Error("Amount exceeds the supported range.");
  return amount;
}
type RunCommand = (
  command: Record<string, unknown>,
  version?: number,
) => Promise<void>;

function InvoiceEditor({
  invoice,
  data,
  busy,
  run,
  report,
}: {
  invoice?: BillingInvoice;
  data: BillingAdministrationData;
  busy: boolean;
  run: RunCommand;
  report: (message: string) => void;
}) {
  const linesDirty = useRef(false);
  const [rows, setRows] = useState<PartnerInvoiceDraftRow[]>(
    invoice?.lines.map((line, index) => ({ key: String(index), ...line })) ?? [
      {
        key: "0",
        description: "",
        quantity: "1",
        unitAmountCents: null,
      },
    ],
  );
  const [selectedJob, setSelectedJob] = useState(invoice?.jobId ?? "");
  const job = data.jobs.find((row) => row.id === selectedJob);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      const lines = rows.map((row) => ({
        description: formEntryText(values.get(`description-${row.key}`)),
        quantity: formEntryText(values.get(`quantity-${row.key}`)),
        unitAmountCents: cents(values.get(`unit-${row.key}`)),
      }));
      const email = formEntryText(values.get("email")).trim();
      await run(
        {
          action: invoice ? "revise_invoice" : "create_invoice",
          ...(invoice ? { invoiceId: invoice.id } : { jobId: selectedJob }),
          lines,
          taxCents: cents(values.get("tax")),
          discountCents: cents(values.get("discount")),
          depositCents: cents(values.get("deposit")),
          poNumber: formEntryText(values.get("po")).trim() || null,
          costCenter: formEntryText(values.get("cost")).trim() || null,
          billingContact: {
            name: formEntryText(values.get("name")),
            ...(email ? { email } : {}),
          },
          terms: formEntryText(values.get("terms")).trim() || null,
          dueDate: formEntryText(values.get("due")) || null,
          reason: formEntryText(values.get("reason")),
        },
        invoice?.version,
      );
    } catch (error) {
      report(
        error instanceof Error ? error.message : "Check the invoice amounts.",
      );
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-4">
      {!invoice && (
        <label className="block text-sm font-medium">
          Job
          <select
            required
            className={`${INPUT} mt-1`}
            value={selectedJob}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              if (
                id === selectedJob ||
                (linesDirty.current &&
                  !window.confirm(
                    "Replace these edited invoice lines with the selected job's services?",
                  ))
              )
                return;
              const next = data.jobs.find((entry) => entry.id === id);
              setSelectedJob(id);
              if (next) setRows(partnerInvoiceRowsForJob(next));
              else
                setRows([
                  {
                    key: crypto.randomUUID(),
                    description: "",
                    quantity: "1",
                    unitAmountCents: null,
                  },
                ]);
              linesDirty.current = false;
            }}
          >
            <option value="">Choose a job</option>
            {data.jobs.map((row) => (
              <option key={row.id} value={row.id}>
                {row.reference || row.service || "Service"} ·{" "}
                {row.id.slice(0, 8)} ·{" "}
                {row.totalCents === null
                  ? "Price needs review"
                  : money(row.totalCents)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-sm text-slate-600">
        Invoice lines, tax, and discount must match the approved or final CRM
        job total{job?.totalCents != null ? ` of ${money(job.totalCents)}` : ""}
        . Change the job or approved change order first if its price is wrong.
      </p>
      {job?.serviceLines?.some(
        (line) => `${line.title}\n${line.description}`.length > 1000,
      ) ? (
        <p className="text-sm text-slate-600">
          Detailed work descriptions remain in the request. Review the concise
          service descriptions below for this invoice.
        </p>
      ) : null}
      <fieldset
        className="space-y-3"
        disabled={busy}
        onChange={() => {
          linesDirty.current = true;
        }}
      >
        <legend className="mb-2 text-sm font-semibold">Invoice lines</legend>
        {rows.map((row, index) => (
          <div
            key={row.key}
            className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
          >
            <label className="text-sm">
              Description {index + 1}
              <input
                required
                maxLength={1000}
                name={`description-${row.key}`}
                defaultValue={row.description}
                className={INPUT}
              />
            </label>
            <label className="text-sm">
              Quantity
              <input
                required
                inputMode="decimal"
                name={`quantity-${row.key}`}
                defaultValue={row.quantity}
                pattern="[0-9]+([.][0-9]{1,3})?"
                className={INPUT}
              />
            </label>
            <label className="text-sm">
              Unit price ($)
              <input
                required
                inputMode="decimal"
                name={`unit-${row.key}`}
                defaultValue={
                  row.unitAmountCents === null
                    ? ""
                    : (row.unitAmountCents / 100).toFixed(2)
                }
                className={INPUT}
              />
            </label>
            <button
              type="button"
              className={`${BUTTON} self-end`}
              disabled={rows.length === 1 || busy}
              onClick={() => {
                linesDirty.current = true;
                setRows((current) =>
                  current.filter((item) => item.key !== row.key),
                );
              }}
              aria-label={`Remove line ${index + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className={BUTTON}
          disabled={rows.length >= 100 || busy}
          onClick={() => {
            linesDirty.current = true;
            setRows((current) => [
              ...current,
              {
                key: crypto.randomUUID(),
                description: "",
                quantity: "1",
                unitAmountCents: null,
              },
            ]);
          }}
        >
          Add line
        </button>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["tax", "Tax ($)", invoice?.taxCents],
            ["discount", "Discount ($)", invoice?.discountCents],
            ["deposit", "Deposit requested ($)", invoice?.depositCents],
          ] as const
        ).map(([name, label, value]) => (
          <label key={name} className="text-sm">
            {label}
            <input
              required
              inputMode="decimal"
              className={INPUT}
              name={name}
              defaultValue={((value ?? 0) / 100).toFixed(2)}
            />
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Billing contact
          <input
            required
            maxLength={200}
            name="name"
            defaultValue={invoice?.billingContact.name ?? data.account.name}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          Billing email (optional)
          <input
            type="email"
            maxLength={320}
            name="email"
            defaultValue={invoice?.billingContact.email ?? ""}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          Purchase order (optional)
          <input
            name="po"
            maxLength={100}
            defaultValue={invoice?.poNumber ?? ""}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          Cost center (optional)
          <input
            name="cost"
            maxLength={100}
            defaultValue={invoice?.costCenter ?? ""}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          Due date (optional)
          <input
            name="due"
            type="date"
            defaultValue={invoice?.dueDate ?? ""}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          Payment terms (optional)
          <input
            name="terms"
            maxLength={1000}
            defaultValue={invoice?.terms ?? ""}
            className={INPUT}
          />
        </label>
      </div>
      <label className="block text-sm">
        Reason for this draft
        <input
          name="reason"
          required
          minLength={3}
          maxLength={192}
          className={`${INPUT} mt-1`}
        />
      </label>
      <button disabled={busy} className={PRIMARY}>
        {busy ? "Saving…" : "Save draft for review"}
      </button>
    </form>
  );
}

function CorrectionForm({
  invoice,
  kind,
  busy,
  run,
  report,
}: {
  invoice: BillingInvoice;
  kind: "credit_invoice" | "void_invoice" | "issue_invoice";
  busy: boolean;
  run: RunCommand;
  report: (message: string) => void;
}) {
  const label =
    kind === "credit_invoice"
      ? "Apply credit"
      : kind === "void_invoice"
        ? "Void invoice"
        : "Issue reviewed invoice";
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) =>
        void (async () => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          try {
            await run(
              {
                action: kind,
                invoiceId: invoice.id,
                reason: formEntryText(form.get("reason")),
                ...(kind === "credit_invoice"
                  ? { amountCents: cents(form.get("amount")) }
                  : {}),
              },
              invoice.version,
            );
          } catch (error) {
            report(
              error instanceof Error ? error.message : "Check the amount.",
            );
          }
        })()
      }
    >
      {kind === "credit_invoice" && (
        <label className="block text-sm">
          Credit amount ($)
          <input className={INPUT} name="amount" inputMode="decimal" required />
        </label>
      )}
      <label className="block text-sm">
        Reason
        <input
          className={INPUT}
          name="reason"
          required
          minLength={3}
          maxLength={192}
        />
      </label>
      <button
        disabled={busy}
        className={kind === "issue_invoice" ? PRIMARY : BUTTON}
      >
        {label}
      </button>
    </form>
  );
}

function RefundForm({
  invoice,
  busy,
  run,
  report,
}: {
  invoice: BillingInvoice;
  busy: boolean;
  run: RunCommand;
  report: (message: string) => void;
}) {
  const [paymentId, setPaymentId] = useState("");
  const payment = invoice.payments.find((row) => row.paymentId === paymentId);
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) =>
        void (async () => {
          event.preventDefault();
          if (!payment) return;
          const values = new FormData(event.currentTarget);
          try {
            await run(
              {
                action:
                  payment.provider === "manual"
                    ? "record_manual_refund"
                    : "refund_payment",
                invoiceId: invoice.id,
                paymentId,
                amountCents: cents(values.get("amount")),
                reason: formEntryText(values.get("reason")),
                ...(payment.provider === "manual"
                  ? {
                      confirmation:
                        values.get("confirmation") === "on"
                          ? "REFUND ALREADY GIVEN"
                          : "",
                    }
                  : {}),
              },
              invoice.version,
            );
          } catch (error) {
            report(
              error instanceof Error
                ? error.message
                : "Check the refund amount.",
            );
          }
        })()
      }
    >
      <p className="text-sm text-slate-600">
        Online refunds return money to its original method. Recording a
        cash/check refund confirms money was already returned; it does not send
        money. A separate credit reduces the bill.
      </p>
      <label className="block text-sm">
        Settled payment
        <select
          className={INPUT}
          required
          value={paymentId}
          onChange={(event) => setPaymentId(event.target.value)}
        >
          <option value="">Choose payment</option>
          {invoice.payments
            .filter(
              (row) =>
                row.status === "completed" &&
                row.totalCents > row.refundedCents,
            )
            .map((row) => (
              <option key={row.paymentId} value={row.paymentId}>
                {row.method || row.provider} ·{" "}
                {money(row.totalCents - row.refundedCents)} remaining
              </option>
            ))}
        </select>
      </label>
      <label className="block text-sm">
        Refund amount ($)
        <input className={INPUT} name="amount" inputMode="decimal" required />
      </label>
      <label className="block text-sm">
        Reason
        <input
          className={INPUT}
          name="reason"
          required
          minLength={3}
          maxLength={192}
        />
      </label>
      {payment?.provider === "manual" && (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="confirmation"
            required
            className="h-5 w-5"
          />
          I have already returned this cash/check amount to the partner.
        </label>
      )}
      <button disabled={busy || !payment} className={BUTTON}>
        {payment?.provider === "manual"
          ? "Record completed cash/check refund"
          : "Request refund to original method"}
      </button>
    </form>
  );
}

function ManualPaymentForm({
  invoice,
  busy,
  run,
  report,
}: {
  invoice: BillingInvoice;
  busy: boolean;
  run: RunCommand;
  report: (message: string) => void;
}) {
  const clientRequestId = useRef<string | null>(null);
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !event.currentTarget.reportValidity()) return;
        const values = new FormData(event.currentTarget);
        try {
          clientRequestId.current ??= crypto.randomUUID();
          void run(
            {
              action: "record_manual_payment",
              invoiceId: invoice.id,
              clientRequestId: clientRequestId.current,
              method: formEntryText(values.get("method")),
              amountCents: cents(values.get("amount")),
              reference: formEntryText(values.get("reference")).trim() || null,
              reason: formEntryText(values.get("reason")),
              confirmation: "PAYMENT ALREADY RECEIVED",
            },
            invoice.version,
          );
        } catch (error) {
          report(
            error instanceof Error
              ? error.message
              : "Check the received payment.",
          );
        }
      }}
    >
      <p className="text-sm text-slate-600">
        Record money Stonegate has already received. This updates the invoice
        and creates a receipt.
      </p>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm" htmlFor="partner-manual-payment-method">
          Payment method
          <select
            id="partner-manual-payment-method"
            name="method"
            className={INPUT}
            defaultValue="cash"
          >
            <option value="cash">Cash</option>
            <option value="check">Check</option>
          </select>
        </label>
        <label className="text-sm" htmlFor="partner-manual-payment-amount">
          Amount received ($)
          <input
            id="partner-manual-payment-amount"
            name="amount"
            required
            inputMode="decimal"
            className={INPUT}
            placeholder="0.00"
          />
        </label>
        <label
          className="text-sm sm:col-span-2"
          htmlFor="partner-manual-payment-reference"
        >
          Check number or reference (optional)
          <input
            id="partner-manual-payment-reference"
            name="reference"
            maxLength={120}
            className={INPUT}
          />
        </label>
        <label
          className="text-sm sm:col-span-2"
          htmlFor="partner-manual-payment-reason"
        >
          Payment note
          <input
            id="partner-manual-payment-reason"
            name="reason"
            required
            minLength={3}
            maxLength={192}
            className={INPUT}
            placeholder="Who received it and when"
          />
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
          <input type="checkbox" required className="h-5 w-5" />I confirm
          Stonegate has already received this payment.
        </label>
        <button className={PRIMARY} disabled={busy}>
          Record received payment
        </button>
      </fieldset>
    </form>
  );
}

export function PartnerBillingAdministrationClient({
  initial,
  canManage,
  canCollect = false,
}: {
  initial: BillingAdministrationData;
  canManage: boolean;
  canCollect?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busyRef = useRef(false);
  const keys = useRef(new Map<string, string>());
  const selected = data.invoices.find((row) => row.id === selectedId);
  async function load(
    options: {
      cursor?: string;
      jobCursor?: string;
      statementCursor?: string;
      invoiceId?: string;
    } = {},
    append = false,
  ) {
    const result = await loadPartnerBillingAdministration(
      data.account.id,
      options,
    );
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }
    setData((current) => ({
      ...result.data,
      ...(append
        ? {
            invoices: [
              ...new Map(
                [...current.invoices, ...result.data.invoices].map((row) => [
                  row.id,
                  row,
                ]),
              ).values(),
            ],
            jobs: [
              ...new Map(
                [...current.jobs, ...result.data.jobs].map((row) => [
                  row.id,
                  row,
                ]),
              ).values(),
            ],
            statements: [
              ...new Map(
                [...current.statements, ...result.data.statements].map(
                  (row) => [row.id, row],
                ),
              ).values(),
            ],
            nextStatementCursor:
              options.cursor || options.invoiceId || options.jobCursor
                ? current.nextStatementCursor
                : result.data.nextStatementCursor,
            nextCursor:
              options.jobCursor || options.statementCursor
                ? current.nextCursor
                : result.data.nextCursor,
            nextJobCursor:
              options.cursor || options.invoiceId || options.statementCursor
                ? current.nextJobCursor
                : result.data.nextJobCursor,
          }
        : {}),
    }));
  }
  const run: RunCommand = async (command, version) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback("");
    const signature = JSON.stringify({ command, version });
    let key = keys.current.get(signature);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(signature, key);
    }
    try {
      const result = await savePartnerBillingCommand(
        data.account.id,
        command,
        key,
        version,
      );
      setFeedback(result.message);
      if (result.ok) {
        keys.current.delete(signature);
        if (result.invoiceId) {
          setSelectedId(result.invoiceId);
          await load({ invoiceId: result.invoiceId }, true);
        } else await load();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  async function download(documentId: string) {
    const result = await getStaffBillingDocument(data.account.id, documentId);
    if (!result.ok) setFeedback(result.message);
    else window.location.assign(result.url);
  }
  return (
    <div className="mt-5 space-y-5">
      <div
        role="status"
        aria-live="polite"
        className={
          feedback
            ? "rounded-lg bg-slate-50 p-3 text-sm text-slate-800"
            : "sr-only"
        }
      >
        {feedback}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={BUTTON} disabled={busy} onClick={() => void load()}>
          Refresh billing
        </button>
        {canManage && (
          <button
            className={BUTTON}
            disabled={busy}
            onClick={() => setSelectedId("new")}
          >
            Create invoice draft
          </button>
        )}
      </div>
      {selectedId === "new" && canManage && (
        <div className="border-t border-slate-200 pt-4">
          <h4 className="font-semibold">New invoice draft</h4>
          <InvoiceEditor
            data={data}
            busy={busy}
            run={run}
            report={setFeedback}
          />
          {data.nextJobCursor && (
            <button
              className={`${BUTTON} mt-3`}
              onClick={() =>
                void load({ jobCursor: data.nextJobCursor! }, true)
              }
            >
              Load more jobs
            </button>
          )}
        </div>
      )}
      <ul className="divide-y divide-slate-200">
        {data.invoices.map((invoice) => (
          <li
            key={invoice.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="break-all text-sm font-semibold">
                {invoice.number}
              </p>
              <p className="text-sm text-slate-600">
                {invoice.status.replaceAll("_", " ")} ·{" "}
                {money(invoice.balanceCents)} due
                {invoice.dueDate ? ` · due ${invoice.dueDate}` : ""}
              </p>
            </div>
            <button
              className={BUTTON}
              onClick={() => setSelectedId(invoice.id)}
              aria-expanded={selectedId === invoice.id}
            >
              Open invoice
            </button>
          </li>
        ))}
      </ul>
      {data.invoices.length === 0 && (
        <p className="text-sm text-slate-600">
          No invoices yet. Create a draft from a priced job when it is ready to
          bill.
        </p>
      )}
      {data.nextCursor && (
        <button
          className={BUTTON}
          onClick={() => void load({ cursor: data.nextCursor! }, true)}
        >
          Load more invoices
        </button>
      )}
      {selected && (
        <section
          className="space-y-4 rounded-xl border border-slate-200 p-4"
          aria-label="Selected invoice"
        >
          <h4 className="break-all font-semibold">{selected.number}</h4>
          {selected.jobId && (
            <PartnerAllocationReconciliation
              key={selected.jobId}
              accountId={data.account.id}
              jobId={selected.jobId}
              canManage={canManage}
            />
          )}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Invoice total", selected.totalCents],
              ["Settled payments", selected.paidCents],
              ["Credits", selected.creditedCents],
              ["Balance due", selected.balanceCents],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-slate-600">{label}</dt>
                <dd className="mt-1 font-semibold">{money(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <ul className="divide-y divide-slate-100 text-sm">
            {selected.lines.map((line, index) => (
              <li key={index} className="flex justify-between gap-3 py-2">
                <span>
                  {line.description} · {line.quantity} ×{" "}
                  {money(line.unitAmountCents)}
                </span>
                <span>{money(line.lineTotalCents)}</span>
              </li>
            ))}
          </ul>
          <PartnerBillingHistory
            key={`documents:${data.account.id}:${selected.id}:${selected.version}`}
            accountId={data.account.id}
            invoiceId={selected.id}
            currency={selected.currency}
            kind="documents"
            download={download}
          />
          {selected.payments.length > 0 && (
            <div>
              <h5 className="text-sm font-semibold">Payment history</h5>
              <ul className="mt-2 space-y-1 text-sm">
                {selected.payments.map((payment) => (
                  <li key={payment.paymentId}>
                    {payment.method || payment.provider}:{" "}
                    {money(payment.amountCents)} applied · {payment.status}
                    {payment.refundedCents
                      ? ` · ${money(payment.refundedCents)} refunded`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <PartnerBillingHistory
            key={`refunds:${data.account.id}:${selected.id}:${selected.version}`}
            accountId={data.account.id}
            invoiceId={selected.id}
            currency={selected.currency}
            kind="refunds"
            download={download}
          />
          {canManage && selected.status === "draft" && (
            <>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 font-medium">
                  Edit draft
                </summary>
                <InvoiceEditor
                  key={`${selected.id}:${selected.version}`}
                  invoice={selected}
                  data={data}
                  busy={busy}
                  run={run}
                  report={setFeedback}
                />
              </details>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 font-medium">
                  Review and issue invoice
                </summary>
                <p className="text-sm text-slate-600">
                  Issuing locks the amounts and lines, prepares the PDF, and
                  makes the bill visible to authorized partner billing users.
                </p>
                <CorrectionForm
                  invoice={selected}
                  kind="issue_invoice"
                  busy={busy}
                  run={run}
                  report={setFeedback}
                />
              </details>
            </>
          )}
          {canManage &&
          canCollect &&
          selected.requestModelVersion === 2 &&
          ["issued", "partially_paid", "overdue"].includes(selected.status) &&
          selected.balanceCents > 0 ? (
            <details>
              <summary className="min-h-11 cursor-pointer py-3 font-medium">
                Record cash or check received
              </summary>
              <ManualPaymentForm
                key={`${selected.id}:${selected.version}`}
                invoice={selected}
                busy={busy}
                run={run}
                report={setFeedback}
              />
            </details>
          ) : null}
          {canManage && selected.status !== "void" && (
            <details>
              <summary className="min-h-11 cursor-pointer py-3 font-medium">
                Corrections and refunds
              </summary>
              <div className="space-y-5">
                {selected.status !== "draft" && selected.balanceCents > 0 && (
                  <div>
                    <h5 className="font-medium">Reduce the unpaid bill</h5>
                    <CorrectionForm
                      invoice={selected}
                      kind="credit_invoice"
                      busy={busy}
                      run={run}
                      report={setFeedback}
                    />
                  </div>
                )}
                {selected.paidCents === 0 && (
                  <div>
                    <h5 className="font-medium">Void this invoice</h5>
                    <CorrectionForm
                      invoice={selected}
                      kind="void_invoice"
                      busy={busy}
                      run={run}
                      report={setFeedback}
                    />
                  </div>
                )}
                {selected.payments.length > 0 && (
                  <div>
                    <h5 className="font-medium">Return a settled payment</h5>
                    <RefundForm
                      key={`${selected.id}:${selected.version}`}
                      invoice={selected}
                      busy={busy}
                      run={run}
                      report={setFeedback}
                    />
                  </div>
                )}
              </div>
            </details>
          )}
        </section>
      )}
      <details className="border-t border-slate-200 pt-2">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">
          Account statements
        </summary>
        {canManage && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) =>
              void (async () => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                await run({
                  action: "generate_statement",
                  periodStart: formEntryText(values.get("start")),
                  periodEnd: formEntryText(values.get("end")),
                  reason: formEntryText(values.get("reason")),
                });
              })()
            }
          >
            <label className="text-sm">
              From
              <input required type="date" name="start" className={INPUT} />
            </label>
            <label className="text-sm">
              Through
              <input required type="date" name="end" className={INPUT} />
            </label>
            <label className="text-sm sm:col-span-2">
              Reason
              <input
                required
                minLength={3}
                maxLength={192}
                name="reason"
                className={INPUT}
              />
            </label>
            <button className={BUTTON} disabled={busy}>
              Generate statement PDF
            </button>
          </form>
        )}
        <ul className="mt-4 space-y-2 text-sm">
          {data.statements.map((statement) => (
            <li
              key={statement.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                {statement.periodStart}–{statement.periodEnd} · version{" "}
                {statement.revision} · {money(statement.closingBalanceCents)}{" "}
                closing balance
              </span>
              {statement.documentId && (
                <button
                  className={BUTTON}
                  onClick={() => void download(statement.documentId!)}
                >
                  Download statement
                </button>
              )}
            </li>
          ))}
        </ul>
        {!data.statements.length && (
          <p className="mt-3 text-sm text-slate-600">
            No generated statements. Pending payments are excluded until
            settlement.
          </p>
        )}
        {data.nextStatementCursor ? (
          <button
            className={BUTTON}
            disabled={busy}
            onClick={() =>
              void load({ statementCursor: data.nextStatementCursor! }, true)
            }
          >
            Load more statements
          </button>
        ) : null}
      </details>
    </div>
  );
}
