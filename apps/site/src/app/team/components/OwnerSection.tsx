import React from "react";
import Link from "next/link";
import { OwnerAssistClient } from "./OwnerAssistClient";

export async function OwnerSection(): Promise<React.ReactElement> {
  return (
    <section className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Owner Assist</h2>
            <p className="text-sm text-slate-600">
              Ask about revenue, payments, schedule, or projections. Answers are grounded in live data when available.
            </p>
          </div>
          <Link
            href="/team?tab=payments"
            className="inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-3 py-1.5 text-xs font-semibold text-primary-800 shadow-sm transition hover:border-primary-300 hover:bg-white"
          >
            View Payments
          </Link>
        </div>
      </div>

      <OwnerAssistClient />
    </section>
  );
}
