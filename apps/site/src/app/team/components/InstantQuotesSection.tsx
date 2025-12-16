import React from "react";
import { callAdminApi } from "../lib/api";
import { deleteInstantQuoteAction } from "../actions";
import { DeleteInstantQuoteForm } from "./DeleteInstantQuoteForm";

type InstantQuoteDto = {
  id: string;
  createdAt: string;
  contactName: string;
  contactPhone: string;
  timeframe: string;
  zip: string;
  jobTypes: string[];
  perceivedSize: string;
  photoUrls: string[];
  aiResult: {
    loadFractionEstimate: number;
    priceLow: number;
    priceHigh: number;
    priceLowDiscounted?: number;
    priceHighDiscounted?: number;
    discountPercent?: number;
    displayTierLabel: string;
    reasonSummary: string;
    needsInPersonEstimate: boolean;
  };
};

export async function InstantQuotesSection(): Promise<React.ReactElement> {
  const res = await callAdminApi("/api/admin/instant-quotes");
  if (!res.ok) {
    return <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Instant quotes unavailable.</div>;
  }
  const data = (await res.json()) as { quotes?: InstantQuoteDto[] };
  const quotes = data.quotes ?? [];

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Instant Quotes</h3>
          <p className="text-xs text-slate-500">Latest 50 photo/AI quotes</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">{quotes.length}</span>
      </div>
      <div className="space-y-2">
        {quotes.map((q) => {
          const discount = q.aiResult.discountPercent ?? 0;
          const low = q.aiResult.priceLowDiscounted ?? q.aiResult.priceLow;
          const high = q.aiResult.priceHighDiscounted ?? q.aiResult.priceHigh;
          return (
            <div
              key={q.id}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-slate-900">{q.contactName}</div>
                <div className="text-[11px] text-slate-500">{new Date(q.createdAt).toLocaleString()}</div>
              </div>
              <div className="text-xs text-slate-600">
                {q.contactPhone} • {q.zip} • timeframe: {q.timeframe}
              </div>
              <div className="mt-1 text-[13px] font-semibold text-primary-800">
                ${low} – ${high}{" "}
                {discount > 0 ? (
                  <span className="ml-2 rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-bold text-primary-800">
                    {Math.round(discount * 100)}% off
                  </span>
                ) : null}
              </div>
              <div className="text-[12px] text-slate-600">
                {q.aiResult.displayTierLabel} • {q.aiResult.loadFractionEstimate.toFixed(2)} trailer • {q.aiResult.reasonSummary}
              </div>
              <div className="text-[12px] text-slate-600">
                Types: {q.jobTypes.join(", ")} | Size: {q.perceivedSize} | Photos: {q.photoUrls.length}
              </div>
              {q.aiResult.needsInPersonEstimate ? (
                <div className="mt-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                  Needs in-person review
                </div>
              ) : null}
              <div className="mt-2">
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={`/team/instant-quotes/${q.id}`}
                    className="text-[11px] font-semibold text-primary-700 underline"
                  >
                    View details / book from quote
                  </a>
                  <DeleteInstantQuoteForm instantQuoteId={q.id} action={deleteInstantQuoteAction} />
                </div>
              </div>
            </div>
          );
        })}
        {!quotes.length ? <div className="text-xs text-slate-500">No instant quotes yet.</div> : null}
      </div>
    </section>
  );
}
