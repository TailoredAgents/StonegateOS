import React from "react";
import { callAdminApi } from "../lib/api";
import { deleteInstantQuoteAction } from "../actions";
import { DeleteInstantQuoteForm } from "./DeleteInstantQuoteForm";
import { TEAM_TIME_ZONE } from "../lib/timezone";

type InstantQuoteDto = {
  id: string;
  createdAt: string;
  contactName: string;
  contactPhone: string;
  timeframe: string;
  zip: string;
  jobTypes: string[];
  perceivedSize: string;
  notes: string | null;
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

export async function InstantQuoteDetail({ quoteId }: { quoteId: string }) {
  const res = await callAdminApi(`/api/admin/instant-quotes?id=${encodeURIComponent(quoteId)}`);
  if (!res.ok) {
    return <div className="text-sm text-amber-700">Quote not found.</div>;
  }
  const data = (await res.json()) as { quotes?: InstantQuoteDto[] };
  const quote = (data.quotes ?? []).find((q) => q.id === quoteId);
  if (!quote) {
    return <div className="text-sm text-amber-700">Quote not found.</div>;
  }
  const discount = quote.aiResult.discountPercent ?? 0;
  const low = quote.aiResult.priceLowDiscounted ?? quote.aiResult.priceLow;
  const high = quote.aiResult.priceHighDiscounted ?? quote.aiResult.priceHigh;

  const prefill = new URLSearchParams({
    quoteId: quote.id,
    contactName: quote.contactName,
    contactPhone: quote.contactPhone,
    zip: quote.zip
  }).toString();

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between text-sm">
        <div className="font-semibold text-slate-900">{quote.contactName}</div>
        <div className="text-[11px] text-slate-500">
          {new Date(quote.createdAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })}
        </div>
      </div>
      <div className="text-xs text-slate-600">
        {quote.contactPhone} • {quote.zip} • timeframe: {quote.timeframe}
      </div>
      <div className="text-lg font-semibold text-primary-900">
        ${low} – ${high}{" "}
        {discount > 0 ? (
          <span className="ml-2 rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-bold text-primary-800">
            {Math.round(discount * 100)}% off
          </span>
        ) : null}
      </div>
      <div className="text-xs text-slate-600">
        {quote.aiResult.displayTierLabel} • {quote.aiResult.loadFractionEstimate.toFixed(2)} trailer • {quote.aiResult.reasonSummary}
      </div>
      <div className="text-xs text-slate-600">
        Types: {quote.jobTypes.join(", ")} | Size: {quote.perceivedSize} | Photos: {quote.photoUrls.length}
      </div>
      {quote.notes ? <div className="text-xs text-slate-600">Notes: {quote.notes}</div> : null}
      {quote.photoUrls.length ? (
        <div className="flex flex-wrap gap-2">
          {quote.photoUrls.map((url, idx) => (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700"
            >
              Photo {idx + 1}
            </a>
          ))}
        </div>
      ) : null}
      {quote.aiResult.needsInPersonEstimate ? (
        <div className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
          Needs in-person review
        </div>
      ) : null}
      <div className="pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/team/instant-quotes/${quote.id}?${prefill}`}
            className="inline-flex items-center rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700"
          >
            Book from this quote
          </a>
          <DeleteInstantQuoteForm instantQuoteId={quote.id} action={deleteInstantQuoteAction} />
        </div>
      </div>
    </div>
  );
}
