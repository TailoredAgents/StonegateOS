import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";

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
    </section>
  );
}
