import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { callAdminApi } from "../lib/api";

type PaymentDto = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  cardBrand: string | null;
  last4: string | null;
  createdAt: string;
};

export async function OwnerSection(): Promise<React.ReactElement> {
  let payments: PaymentDto[] | null = null;
  let paymentsError: string | null = null;
  try {
    const res = await callAdminApi("/api/payments?status=all&limit=10");
    if (res.ok) {
      const payload = (await res.json()) as { payments?: PaymentDto[] };
      payments = payload.payments ?? [];
    } else {
      paymentsError = `Payments unavailable (HTTP ${res.status})`;
    }
  } catch (error) {
    paymentsError = "Payments not connected yet.";
  }

  return (
    <section className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Owner HQ</h2>
            <p className="text-sm text-slate-600">
              Ask about revenue, payments, schedule, or projections. Answers are grounded in live data when available.
            </p>
          </div>
        </div>
      </div>

      <OwnerAssistClient />

      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Payments</h3>
            <p className="text-sm text-slate-600">Recent payments (connect Stripe to populate).</p>
          </div>
        </div>
        <div className="mt-4 space-y-2 text-sm text-slate-700">
          {paymentsError ? (
            <p className="text-amber-700">{paymentsError}</p>
          ) : payments && payments.length ? (
            <ul className="space-y-1">
              {payments.slice(0, 5).map((p) => (
                <li key={p.id} className="flex justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <div className="font-semibold text-slate-900">
                      {(p.currency ?? "USD").toUpperCase()} {(p.amount / 100).toFixed(2)}
                    </div>
                    <div className="text-[11px] uppercase text-slate-500">{p.status}</div>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <div>{p.cardBrand ?? p.method ?? "payment"}</div>
                    <div>{new Date(p.createdAt).toLocaleDateString()}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-600">No payments yet. Connect Stripe to start seeing revenue.</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
          <h3 className="text-lg font-semibold text-slate-900">Expenses</h3>
          <p className="text-sm text-slate-600">
            Expenses tracking isn&apos;t connected yet. Add expense data to see spend and savings opportunities here.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
          <h3 className="text-lg font-semibold text-slate-900">P&amp;L</h3>
          <p className="text-sm text-slate-600">
            Monthly and yearly P&amp;L will appear once revenue and expenses are connected. Right now only payments are available.
          </p>
        </div>
      </div>
    </section>
  );
}
