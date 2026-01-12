"use client";

import { useEffect, useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";

type Payment = {
  id: string;
  stripeChargeId: string;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  createdAt: string;
  appointment: null | { id: string; status: string; startAt: string | null; contactName: string | null };
};

function fmtMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

type AttachAction = (formData: FormData) => void;

type ApptItem = {
  id: string;
  startAt: string | null;
  contact: { name: string };
  property: { addressLine1: string; city: string };
};

export function PaymentsList({
  initial,
  summary,
  attachAction,
  detachAction
}: {
  initial: Payment[];
  summary: { total: number; matched: number; unmatched: number };
  attachAction: AttachAction;
  detachAction: AttachAction;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<string>("all");
  const [appts, setAppts] = useState<ApptItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/appointments?status=all", { cache: "no-store" });
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
        it.stripeChargeId.toLowerCase().includes(hay) ||
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
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search charge ID or name"
          className="min-w-[240px] flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border border-neutral-300 px-2 py-1 text-sm">
          <option value="all">All</option>
          <option value="matched">Matched</option>
          <option value="unmatched">Unmatched</option>
        </select>
      </div>
      <ul className="space-y-3">
        {filtered.map((p) => (
          <li key={p.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-primary-900">{fmtMoney(p.amount, p.currency)}</p>
                <p className="text-xs text-neutral-500">
                  {p.stripeChargeId.slice(0, 10)}... - {p.status}
                </p>
                {p.appointment ? (
                  <p className="text-xs text-neutral-600">Linked to {p.appointment.contactName ?? "appointment"}</p>
                ) : (
                  <p className="text-xs text-rose-600">Unmatched</p>
                )}
              </div>
              {p.receiptUrl ? (
                <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-neutral-600 underline">Receipt</a>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {p.appointment ? (
                <form action={detachAction}>
                  <input type="hidden" name="paymentId" value={p.id} />
                  <SubmitButton className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-700" pendingLabel="Detaching...">Detach</SubmitButton>
                </form>
              ) : (
                <form action={attachAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="paymentId" value={p.id} />
                  <input list={`appts-${p.id}`} name="appointmentId" placeholder="Search or enter ID" className="min-w-[220px] rounded-md border border-neutral-300 px-2 py-1 text-xs" />
                  <datalist id={`appts-${p.id}`}>
                    {appts.map((a) => (
                      <option key={a.id} value={a.id}>{`${a.contact.name} - ${a.property.addressLine1}, ${a.property.city}`}</option>
                    ))}
                  </datalist>
                  <SubmitButton className="rounded-md bg-primary-800 px-3 py-1 text-xs font-semibold text-white" pendingLabel="Attaching...">Attach</SubmitButton>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}


