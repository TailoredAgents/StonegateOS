"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { teamSurfaceHref } from "./surface-registry";

type Payment = {
  id: string;
  stripeChargeId: string | null;
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  amount: number;
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  currency: string;
  status: string;
  canonicalStatus: string;
  method: string | null;
  tenderType: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  legacySource: string | null;
  createdAt: string;
  updatedAt: string;
  appointment: null | {
    id: string;
    status: string;
    startAt: string | null;
    contactName: string | null;
  };
};

function fmtMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

type AttachAction = (formData: FormData) => Promise<void>;

type ApptItem = {
  id: string;
  startAt: string | null;
  contact: { name: string };
  property: { addressLine1: string; city: string };
};

function paymentIdentifier(payment: Payment): string {
  return (
    payment.providerPaymentId ??
    payment.stripeChargeId ??
    payment.providerOrderId ??
    payment.id
  );
}

export function PaymentsList({
  initial,
  summary,
  attachAction,
  detachAction,
  canChangeAssociations,
}: {
  initial: Payment[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    needsReview?: number;
  };
  attachAction: AttachAction;
  detachAction: AttachAction;
  canChangeAssociations: boolean;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<string>("all");
  const [appts, setAppts] = useState<ApptItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/appointments?status=all", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; data: ApptItem[] };
        setAppts(data.data ?? []);
      } catch {
        // ignore
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const hay = q.trim().toLowerCase();
    return initial.filter((it) => {
      if (scope === "matched" && !it.appointment) return false;
      if (scope === "unmatched" && it.appointment) return false;
      if (!hay) return true;
      return (
        paymentIdentifier(it).toLowerCase().includes(hay) ||
        it.provider.toLowerCase().includes(hay) ||
        it.canonicalStatus.toLowerCase().includes(hay) ||
        (it.appointment?.contactName ?? "").toLowerCase().includes(hay)
      );
    });
  }, [initial, q, scope]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-700">
        <span>Total: {summary.total}</span>
        <span>Matched: {summary.matched}</span>
        <span>Unmatched: {summary.unmatched}</span>
        {(summary.needsReview ?? 0) > 0 ? (
          <span className="font-semibold text-amber-700">
            Needs review: {summary.needsReview}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search charge ID or name"
          className="min-w-[240px] flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
        >
          <option value="all">All</option>
          <option value="matched">Matched</option>
          <option value="unmatched">Unmatched</option>
        </select>
      </div>
      <ul className="space-y-3">
        {filtered.map((p) => (
          <li
            key={p.id}
            className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-primary-900">
                  {fmtMoney(p.totalAmountCents, p.currency)}
                </p>
                <p className="text-xs text-neutral-500">
                  {p.provider} · {paymentIdentifier(p).slice(0, 18)}
                  {paymentIdentifier(p).length > 18 ? "…" : ""} ·{" "}
                  {p.canonicalStatus}
                </p>
                {p.legacySource ? (
                  <p className="text-xs text-amber-700">Paid (legacy)</p>
                ) : null}
                {p.appointment ? (
                  <p className="text-xs text-neutral-600">
                    Linked to {p.appointment.contactName ?? "appointment"}
                  </p>
                ) : (
                  <p className="text-xs text-rose-600">Unmatched</p>
                )}
              </div>
              {p.receiptUrl ? (
                <a
                  href={p.receiptUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-neutral-600 underline"
                >
                  Receipt
                </a>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {!canChangeAssociations ? (
                <p className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  You can review this payment, but changing appointment links
                  requires payment reconciliation and management access.
                </p>
              ) : p.appointment ? (
                <details className="w-full rounded-md border border-neutral-200 p-2">
                  <summary className="cursor-pointer text-xs font-semibold text-neutral-700">
                    Detach for owner review
                  </summary>
                  <form action={detachAction} className="mt-2 space-y-2">
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input
                      type="hidden"
                      name="expectedAppointmentId"
                      value={p.appointment.id}
                    />
                    <input
                      type="hidden"
                      name="expectedVersion"
                      value={p.updatedAt}
                    />
                    <input
                      type="hidden"
                      name="expectedProvider"
                      value={p.provider}
                    />
                    <input
                      type="hidden"
                      name="expectedProviderPaymentId"
                      value={p.providerPaymentId ?? ""}
                    />
                    <input
                      type="hidden"
                      name="expectedProviderOrderId"
                      value={p.providerOrderId ?? ""}
                    />
                    <input
                      type="hidden"
                      name="expectedStripeChargeId"
                      value={p.stripeChargeId ?? ""}
                    />
                    <label className="block text-xs font-medium text-neutral-700">
                      Review reason
                      <textarea
                        name="reviewNote"
                        required
                        minLength={3}
                        maxLength={500}
                        placeholder="Why this payment is attached to the wrong job"
                        className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium text-neutral-700">
                      Type DETACH PAYMENT to confirm
                      <input
                        name="confirmation"
                        required
                        autoComplete="off"
                        pattern="DETACH PAYMENT"
                        className="mt-1 min-h-11 w-full rounded-md border border-rose-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <SubmitButton
                      className="min-h-11 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800"
                      pendingLabel="Detaching..."
                    >
                      Detach and flag
                    </SubmitButton>
                  </form>
                </details>
              ) : p.provider === "stripe" ? (
                <form
                  action={attachAction}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="paymentId" value={p.id} />
                  <input
                    type="hidden"
                    name="expectedVersion"
                    value={p.updatedAt}
                  />
                  <input
                    type="hidden"
                    name="expectedProvider"
                    value={p.provider}
                  />
                  <input
                    type="hidden"
                    name="expectedProviderPaymentId"
                    value={p.providerPaymentId ?? ""}
                  />
                  <input
                    type="hidden"
                    name="expectedProviderOrderId"
                    value={p.providerOrderId ?? ""}
                  />
                  <input
                    type="hidden"
                    name="expectedStripeChargeId"
                    value={p.stripeChargeId ?? ""}
                  />
                  <label className="text-xs font-medium text-neutral-700">
                    Appointment
                    <input
                      list={`appts-${p.id}`}
                      name="appointmentId"
                      required
                      placeholder="Search or enter ID"
                      className="mt-1 min-h-11 min-w-[220px] rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <datalist id={`appts-${p.id}`}>
                    {appts.map((a) => (
                      <option
                        key={a.id}
                        value={a.id}
                      >{`${a.contact.name} - ${a.property.addressLine1}, ${a.property.city}`}</option>
                    ))}
                  </datalist>
                  <label className="text-xs font-medium text-neutral-700">
                    Job amount
                    <input
                      name="jobAmount"
                      inputMode="decimal"
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      required
                      defaultValue={(p.jobAmountCents / 100).toFixed(2)}
                      className="mt-1 min-h-11 w-32 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs font-medium text-neutral-700">
                    Tip amount
                    <input
                      name="tipAmount"
                      inputMode="decimal"
                      type="number"
                      min="0"
                      max="100000"
                      step="0.01"
                      required
                      defaultValue={(p.tipCents / 100).toFixed(2)}
                      className="mt-1 min-h-11 w-28 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="min-w-[260px] flex-1 text-xs font-medium text-neutral-700">
                    Review reason
                    <textarea
                      name="reviewNote"
                      required
                      minLength={3}
                      maxLength={500}
                      placeholder="Why this Stripe charge belongs to this job"
                      className="mt-1 min-h-20 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="min-w-[220px] text-xs font-medium text-neutral-700">
                    Type ATTACH PAYMENT to confirm
                    <input
                      name="confirmation"
                      required
                      autoComplete="off"
                      pattern="ATTACH PAYMENT"
                      className="mt-1 min-h-11 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <SubmitButton
                    className="min-h-11 rounded-md bg-primary-800 px-3 py-2 text-xs font-semibold text-white"
                    pendingLabel="Resolving..."
                  >
                    Attach and resolve
                  </SubmitButton>
                </form>
              ) : (
                <Link
                  href={teamSurfaceHref("owner", {
                    query: { ownerView: "payments" },
                  })}
                  className="text-xs font-semibold text-primary-700 underline"
                >
                  Review in Owner HQ
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
