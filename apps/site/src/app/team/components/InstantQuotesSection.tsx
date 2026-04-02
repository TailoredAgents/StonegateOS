import React from "react";
import { callAdminApi } from "../lib/api";
import { deleteInstantQuoteAction } from "../actions";
import { DeleteInstantQuoteForm } from "./DeleteInstantQuoteForm";
import { TEAM_TIME_ZONE } from "../lib/timezone";

function formatLabel(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type InstantQuoteDto = {
  id: string;
  createdAt: string;
  contactName: string;
  contactPhone: string;
  timeframe: string;
  zip: string;
  jobTypes: string[];
  perceivedSize: string;
  photoCount: number;
  aiResult: {
    loadFractionEstimate: number;
    priceLow: number;
    priceHigh: number;
    priceLowDiscounted?: number;
    priceHighDiscounted?: number;
    discountPercent?: number;
    addOnTotal?: number;
    displayTierLabel: string;
    reasonSummary: string;
    needsInPersonEstimate: boolean;
    mediaAnalysis?: {
      visibleVolumeRange?: string;
      mergedVolumeRange?: string;
      confidence?: "low" | "medium" | "high";
    };
  };
  isMediaInformed?: boolean;
  hasBookedAppointment?: boolean;
  tightenedAfterMoreMedia?: boolean;
};

type InstantQuoteSummaryDto = {
  windowStart: string;
  totalQuotes: number;
  bookedQuotes: number;
  mediaInformed: {
    quotes: number;
    bookedQuotes: number;
    bookRate: number;
    highConfidence: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    lowConfidence: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    missingViews: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    weakQuotes: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    tightenedAfterMoreMedia: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    unresolvedWeakMedia: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
  };
  standard: {
    quotes: number;
    bookedQuotes: number;
    bookRate: number;
  };
};

type FollowupBucketDto = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
};

type FollowupSliceDto = {
  quotesWithFollowup: number;
  bookedQuotes: number;
  byChannel: {
    sms: FollowupBucketDto;
    dm: FollowupBucketDto;
    email: FollowupBucketDto;
  };
  byTiming: {
    fast: FollowupBucketDto;
    delayed: FollowupBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
  };
};

type FollowupSummaryDto = FollowupSliceDto & {
  windowStart: string;
  byServiceFamily: {
    junk: FollowupSliceDto;
    demo: FollowupSliceDto;
    brush: FollowupSliceDto;
    unknown: FollowupSliceDto;
  };
  bySourceFamily: {
    facebook: FollowupSliceDto;
    public_site: FollowupSliceDto;
    other: FollowupSliceDto;
    unknown: FollowupSliceDto;
  };
};

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function renderFollowupLearning(label: string, summary: FollowupSliceDto): React.ReactElement {
  const preferredChannel =
    summary.learned.preferredChannel === "sms"
      ? "SMS"
      : summary.learned.preferredChannel === "dm"
        ? "Messenger"
        : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="font-semibold text-slate-900">{label}</div>
      <div className="mt-1 text-[11px] text-slate-600">
        Quotes with follow-up: {summary.quotesWithFollowup} | Booked: {summary.bookedQuotes} (
        {formatPercent(
          summary.quotesWithFollowup > 0 ? summary.bookedQuotes / summary.quotesWithFollowup : 0,
        )}
        )
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        SMS {formatPercent(summary.byChannel.sms.bookRate)} | Messenger {formatPercent(summary.byChannel.dm.bookRate)} |
        Email {formatPercent(summary.byChannel.email.bookRate)}
      </div>
      <div className="text-[11px] text-slate-500">
        Fast follow-up {formatPercent(summary.byTiming.fast.bookRate)} | Delayed {formatPercent(summary.byTiming.delayed.bookRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {preferredChannel ? `Learned channel lean: ${preferredChannel}` : "Learned channel lean: not strong enough yet"}
        {" | "}
        {summary.learned.preferFast ? "Fast first follow-up is outperforming." : "No strong fast-follow-up edge yet."}
      </div>
    </div>
  );
}

export async function InstantQuotesSection(): Promise<React.ReactElement> {
  const res = await callAdminApi("/api/admin/instant-quotes?limit=25");
  if (!res.ok) {
    return <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Instant quotes unavailable.</div>;
  }
  const data = (await res.json()) as {
    quotes?: InstantQuoteDto[];
    summary?: InstantQuoteSummaryDto;
    followupSummary?: FollowupSummaryDto;
  };
  const quotes = data.quotes ?? [];
  const summary = data.summary;
  const followupSummary = data.followupSummary;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Instant Quotes</h3>
          <p className="text-xs text-slate-500">Latest 25 photo/AI quotes</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">{quotes.length}</span>
      </div>
      {summary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Last 90 days</div>
          <div className="mt-1">
            Media-informed quotes booked {summary.mediaInformed.bookedQuotes} of {summary.mediaInformed.quotes} (
            {formatPercent(summary.mediaInformed.bookRate)}), compared with {summary.standard.bookedQuotes} of{" "}
            {summary.standard.quotes} ({formatPercent(summary.standard.bookRate)}) for standard quotes.
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            High-confidence media quotes: {summary.mediaInformed.highConfidence.bookedQuotes} of{" "}
            {summary.mediaInformed.highConfidence.quotes} ({formatPercent(summary.mediaInformed.highConfidence.bookRate)})
            {" | "}Low-confidence: {summary.mediaInformed.lowConfidence.bookedQuotes} of{" "}
            {summary.mediaInformed.lowConfidence.quotes} ({formatPercent(summary.mediaInformed.lowConfidence.bookRate)})
            {" | "}Missing-view cases: {summary.mediaInformed.missingViews.bookedQuotes} of{" "}
            {summary.mediaInformed.missingViews.quotes} ({formatPercent(summary.mediaInformed.missingViews.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Weak media quotes later tightened: {summary.mediaInformed.tightenedAfterMoreMedia.bookedQuotes} of{" "}
            {summary.mediaInformed.tightenedAfterMoreMedia.quotes} (
            {formatPercent(summary.mediaInformed.tightenedAfterMoreMedia.bookRate)})
            {" | "}Still unresolved weak quotes: {summary.mediaInformed.unresolvedWeakMedia.bookedQuotes} of{" "}
            {summary.mediaInformed.unresolvedWeakMedia.quotes} (
            {formatPercent(summary.mediaInformed.unresolvedWeakMedia.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Booked from quote means the quote is linked to a non-canceled appointment.
          </div>
        </div>
      ) : null}
      {followupSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Quote follow-up learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            Planner guidance is now learning from first real follow-up outcomes after a quote, segmented by service family and lead source.
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {renderFollowupLearning("Overall", followupSummary)}
            {renderFollowupLearning("Junk quotes", followupSummary.byServiceFamily.junk)}
            {renderFollowupLearning("Demo quotes", followupSummary.byServiceFamily.demo)}
            {renderFollowupLearning("Brush quotes", followupSummary.byServiceFamily.brush)}
            {renderFollowupLearning("Facebook-sourced", followupSummary.bySourceFamily.facebook)}
            {renderFollowupLearning("Public-site sourced", followupSummary.bySourceFamily.public_site)}
          </div>
        </div>
      ) : null}
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
                <div className="text-[11px] text-slate-500">
                  {new Date(q.createdAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {q.isMediaInformed ? (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
                    Media-informed
                  </span>
                ) : null}
                {q.hasBookedAppointment ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                    Booked from quote
                  </span>
                ) : null}
                {q.tightenedAfterMoreMedia ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                    Tightened after more media
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-slate-600">
                {q.contactPhone} - {q.zip} - timeframe: {q.timeframe}
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
                {q.aiResult.displayTierLabel} - {q.aiResult.loadFractionEstimate.toFixed(2)} trailer - {q.aiResult.reasonSummary}
              </div>
              {q.aiResult.mediaAnalysis ? (
                <div className="text-[11px] text-slate-500">
                  Visible {formatLabel(q.aiResult.mediaAnalysis.visibleVolumeRange)} | Merged{" "}
                  {formatLabel(q.aiResult.mediaAnalysis.mergedVolumeRange)} | {formatLabel(q.aiResult.mediaAnalysis.confidence)}
                  {typeof q.aiResult.addOnTotal === "number" && q.aiResult.addOnTotal > 0
                    ? ` | Add-ons +$${q.aiResult.addOnTotal}`
                    : ""}
                </div>
              ) : null}
              <div className="text-[12px] text-slate-600">
                Types: {q.jobTypes.join(", ")} | Size: {q.perceivedSize} | Photos: {q.photoCount}
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
