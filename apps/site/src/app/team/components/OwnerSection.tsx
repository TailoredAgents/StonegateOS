import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { PaymentsSection } from "./PaymentsSection";

export async function OwnerSection(): Promise<React.ReactElement> {
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
            <p className="text-sm text-slate-600">Review recent payments and attach/detach as needed.</p>
          </div>
        </div>
        <div className="mt-4">
          <PaymentsSection />
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
