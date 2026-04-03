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

type FirstResponseBucketDto = {
  attempts: number;
  replied: number;
  replyRate: number;
  booked: number;
  bookRate: number;
};

type FirstResponseSliceDto = {
  attempts: number;
  replied: number;
  replyRate: number;
  booked: number;
  bookRate: number;
  byChannel: {
    sms: FirstResponseBucketDto;
    dm: FirstResponseBucketDto;
    email: FirstResponseBucketDto;
  };
  byTiming: {
    fast: FirstResponseBucketDto;
    delayed: FirstResponseBucketDto;
  };
  byStyle: {
    short: FirstResponseBucketDto;
    long: FirstResponseBucketDto;
    single_ask: FirstResponseBucketDto;
    multi_ask: FirstResponseBucketDto;
    photo_ask: FirstResponseBucketDto;
    booking_ask: FirstResponseBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
    keepShort: boolean;
    keepSingleAsk: boolean;
    openWithPhotoAsk: boolean;
    avoidHardBookingAsk: boolean;
  };
};

type FirstResponseSummaryDto = FirstResponseSliceDto & {
  windowStart: string;
  byServiceFamily: {
    junk: FirstResponseSliceDto;
    demo: FirstResponseSliceDto;
    brush: FirstResponseSliceDto;
    unknown: FirstResponseSliceDto;
  };
  bySourceFamily: {
    facebook: FirstResponseSliceDto;
    public_site: FirstResponseSliceDto;
    other: FirstResponseSliceDto;
    unknown: FirstResponseSliceDto;
  };
};

type ChannelHandoffSummaryDto = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  transitionedToSms: number;
  smsTransitionRate: number;
  stayedInDm: number;
  stayDmRate: number;
  booked: number;
  bookRate: number;
  learned: {
    worthHandoff: boolean;
    keepLighter: boolean;
    smsTransitionHealthy: boolean;
  };
};

type ObjectionBucketDto = {
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
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
  byDepth: {
    first: FollowupBucketDto;
    second: FollowupBucketDto;
    third_plus: FollowupBucketDto;
  };
  byStyle: {
    short: FollowupBucketDto;
    long: FollowupBucketDto;
    single_ask: FollowupBucketDto;
    multi_ask: FollowupBucketDto;
    photo_ask: FollowupBucketDto;
    booking_ask: FollowupBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
    secondTouchStillWorthwhile: boolean;
    thirdPlusWorthwhile: boolean;
    keepDepthLight: boolean;
    keepShort: boolean;
    keepSingleAsk: boolean;
    openWithPhotoAsk: boolean;
    avoidHardBookingAsk: boolean;
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

type ObjectionSummaryDto = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
  byChannel: {
    sms: ObjectionBucketDto;
    dm: ObjectionBucketDto;
    email: ObjectionBucketDto;
  };
  byType: {
    price: {
      attempts: number;
      reopened: number;
      reopenRate: number;
      booked: number;
      bookRate: number;
      byChannel: {
        sms: ObjectionBucketDto;
        dm: ObjectionBucketDto;
        email: ObjectionBucketDto;
      };
      learned: {
        preferredChannel: "sms" | "dm" | null;
        keepSofter: boolean;
      };
    };
    comparison_shopping: ObjectionSummaryDto["byType"]["price"];
    decision_maker: ObjectionSummaryDto["byType"]["price"];
    timing: ObjectionSummaryDto["byType"]["price"];
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
  };
};

type MissingInfoBucketDto = {
  attempts: number;
  resolved: number;
  resolutionRate: number;
  resolvedWithMedia: number;
  mediaResolutionRate: number;
  resolvedWithText: number;
  textResolutionRate: number;
  booked: number;
  bookRate: number;
};

type MissingInfoSummaryDto = {
  windowStart: string;
  attempts: number;
  resolved: number;
  resolutionRate: number;
  resolvedWithMedia: number;
  mediaResolutionRate: number;
  resolvedWithText: number;
  textResolutionRate: number;
  booked: number;
  bookRate: number;
  byChannel: {
    sms: MissingInfoBucketDto;
    dm: MissingInfoBucketDto;
    email: MissingInfoBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSingleAsk: boolean;
    leanIntoRequests: boolean;
  };
};

type AppointmentReminderBucketDto = {
  attempts: number;
  acknowledged: number;
  acknowledgedRate: number;
  confirmedReplies: number;
  confirmRate: number;
  rescheduleRequests: number;
  rescheduleRequestRate: number;
  rescheduled: number;
  rescheduleSaveRate: number;
  activeAppointments: number;
  activeRate: number;
  completed: number;
  completedRate: number;
  noShows: number;
  noShowRate: number;
};

type AppointmentReminderSummaryDto = {
  windowStart: string;
  attempts: number;
  acknowledged: number;
  acknowledgedRate: number;
  confirmedReplies: number;
  confirmRate: number;
  rescheduleRequests: number;
  rescheduleRequestRate: number;
  rescheduled: number;
  rescheduleSaveRate: number;
  activeAppointments: number;
  activeRate: number;
  completed: number;
  completedRate: number;
  noShows: number;
  noShowRate: number;
  byWindow: {
    "24h": AppointmentReminderBucketDto;
    "2h": AppointmentReminderBucketDto;
    other: AppointmentReminderBucketDto;
  };
  learned: {
    preferredWindow: "24h" | "2h" | "other" | null;
    confirmationLoopHealthy: boolean;
    rescheduleSavesWorking: boolean;
  };
};

type AppointmentPreservationBucketDto = {
  attempts: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  canceled: number;
  canceledRate: number;
  noShows: number;
  noShowRate: number;
};

type AppointmentPreservationSummaryDto = {
  windowStart: string;
  attempts: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  canceled: number;
  canceledRate: number;
  noShows: number;
  noShowRate: number;
  byKind: {
    requested: AppointmentPreservationBucketDto;
    rescheduled: AppointmentPreservationBucketDto;
    reminder: AppointmentPreservationBucketDto;
    other: AppointmentPreservationBucketDto;
  };
  byAppointmentType: {
    estimate: AppointmentPreservationBucketDto;
    in_person_quote: AppointmentPreservationBucketDto;
    job: AppointmentPreservationBucketDto;
    other: AppointmentPreservationBucketDto;
  };
  byServiceFamily: {
    junk: AppointmentPreservationBucketDto;
    demo: AppointmentPreservationBucketDto;
    brush: AppointmentPreservationBucketDto;
    unknown: AppointmentPreservationBucketDto;
  };
  bySourceFamily: {
    facebook: AppointmentPreservationBucketDto;
    public_site: AppointmentPreservationBucketDto;
    other: AppointmentPreservationBucketDto;
    unknown: AppointmentPreservationBucketDto;
  };
  learned: {
    strongestTouchKind: "requested" | "rescheduled" | "reminder" | "other" | null;
    needsHumanBackup: boolean;
  };
};

type QuoteHotWindowBucketDto = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
};

type QuoteHotWindowSliceDto = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
  byWindow: {
    under_6h: QuoteHotWindowBucketDto;
    same_day: QuoteHotWindowBucketDto;
    day_1_3: QuoteHotWindowBucketDto;
    after_3d: QuoteHotWindowBucketDto;
  };
  learned: {
    hotWindow: "under_6h" | "same_day" | "day_1_3" | "slow_burn" | null;
    urgencyDecayFast: boolean;
    sameDayStillStrong: boolean;
  };
};

type QuoteHotWindowSummaryDto = QuoteHotWindowSliceDto & {
  windowStart: string;
  byServiceFamily: {
    junk: QuoteHotWindowSliceDto;
    demo: QuoteHotWindowSliceDto;
    brush: QuoteHotWindowSliceDto;
    unknown: QuoteHotWindowSliceDto;
  };
  bySourceFamily: {
    facebook: QuoteHotWindowSliceDto;
    public_site: QuoteHotWindowSliceDto;
    other: QuoteHotWindowSliceDto;
    unknown: QuoteHotWindowSliceDto;
  };
};

type ReactivationBucketDto = {
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
};

type ReactivationSummaryDto = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
  byChannel: {
    sms: ReactivationBucketDto;
    dm: ReactivationBucketDto;
    email: ReactivationBucketDto;
  };
  byDormancy: {
    day_1_3: ReactivationBucketDto;
    day_3_plus: ReactivationBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
    worthReactivating: boolean;
  };
};

type QuoteCloseBucketDto = {
  attempts: number;
  booked: number;
  bookRate: number;
  lost: number;
  lostRate: number;
};

type QuoteCloseSummaryDto = {
  windowStart: string;
  attempts: number;
  booked: number;
  bookRate: number;
  lost: number;
  lostRate: number;
  byChannel: {
    sms: QuoteCloseBucketDto;
    dm: QuoteCloseBucketDto;
    email: QuoteCloseBucketDto;
  };
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
  };
};

type QuoteAccuracyBucketDto = {
  quotes: number;
  withinRange: number;
  withinRangeRate: number;
  aboveRange: number;
  aboveRangeRate: number;
  belowRange: number;
  belowRangeRate: number;
  averageOutsideByCents: number;
};

type QuoteAccuracySliceDto = {
  attempts: number;
  withinRange: number;
  withinRangeRate: number;
  aboveRange: number;
  aboveRangeRate: number;
  belowRange: number;
  belowRangeRate: number;
  averageOutsideByCents: number;
  byConfidence: {
    high: QuoteAccuracyBucketDto;
    medium: QuoteAccuracyBucketDto;
    low: QuoteAccuracyBucketDto;
    unknown: QuoteAccuracyBucketDto;
  };
  learned: {
    lowConfidenceNeedsTightening: boolean;
    keepQuoteProvisional: boolean;
    tendsAboveRange: boolean;
    highConfidenceTrustworthy: boolean;
  };
};

type QuoteAccuracySummaryDto = {
  windowStart: string;
  attempts: number;
  withinRange: number;
  withinRangeRate: number;
  aboveRange: number;
  aboveRangeRate: number;
  belowRange: number;
  belowRangeRate: number;
  averageOutsideByCents: number;
  byConfidence: QuoteAccuracySliceDto["byConfidence"];
  byServiceFamily: {
    junk: QuoteAccuracySliceDto;
    demo: QuoteAccuracySliceDto;
    brush: QuoteAccuracySliceDto;
    unknown: QuoteAccuracySliceDto;
  };
  bySourceFamily: {
    facebook: QuoteAccuracySliceDto;
    public_site: QuoteAccuracySliceDto;
    other: QuoteAccuracySliceDto;
    unknown: QuoteAccuracySliceDto;
  };
  learned: QuoteAccuracySliceDto["learned"];
};

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function formatUsdCents(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value / 100);
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
      <div className="mt-1 text-[11px] text-slate-500">
        First touch {formatPercent(summary.byDepth.first.bookRate)} | Second touch {formatPercent(summary.byDepth.second.bookRate)} |
        Third plus {formatPercent(summary.byDepth.third_plus.bookRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {summary.learned.secondTouchStillWorthwhile
          ? "Second-touch quote follow-ups are still worth sending."
          : "Second-touch quote follow-ups are weakening."}
        {" | "}
        {summary.learned.thirdPlusWorthwhile
          ? "Third-touch and later quote follow-ups are still worth sending."
          : "Third-touch and later quote follow-ups are weak."}
        {" | "}
        {summary.learned.keepDepthLight
          ? "Later-stage follow-ups should stay light."
          : "No strong late-stage softness warning yet."}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Short {formatPercent(summary.byStyle.short.bookRate)} | Single ask {formatPercent(summary.byStyle.single_ask.bookRate)} |
        Photo ask {formatPercent(summary.byStyle.photo_ask.bookRate)} | Booking ask {formatPercent(summary.byStyle.booking_ask.bookRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {summary.learned.keepShort ? "Short quote nudges are working better." : "No strong short-follow-up edge yet."}
        {" | "}
        {summary.learned.keepSingleAsk ? "One clear ask is performing better." : "No strong single-ask edge yet."}
        {" | "}
        {summary.learned.openWithPhotoAsk
          ? "Photo-first follow-ups are converting better."
          : "No strong photo-first follow-up edge yet."}
        {" | "}
        {summary.learned.avoidHardBookingAsk
          ? "Hard booking asks are underperforming on follow-up."
          : "No strong hard-booking warning yet."}
      </div>
    </div>
  );
}

function renderFirstResponseLearning(label: string, summary: FirstResponseSliceDto): React.ReactElement {
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
        First touches: {summary.attempts} | Replied: {summary.replied} ({formatPercent(summary.replyRate)})
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        SMS reply {formatPercent(summary.byChannel.sms.replyRate)} | Messenger reply {formatPercent(summary.byChannel.dm.replyRate)} |
        Email reply {formatPercent(summary.byChannel.email.replyRate)}
      </div>
      <div className="text-[11px] text-slate-500">
        Fast first touch {formatPercent(summary.byTiming.fast.replyRate)} | Delayed {formatPercent(summary.byTiming.delayed.replyRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {preferredChannel ? `Learned channel lean: ${preferredChannel}` : "Learned channel lean: not strong enough yet"}
        {" | "}
        {summary.learned.preferFast ? "Fast first response is outperforming." : "No strong fast-first-touch edge yet."}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Short opener {formatPercent(summary.byStyle.short.replyRate)} | Single ask {formatPercent(summary.byStyle.single_ask.replyRate)} |
        Photo ask {formatPercent(summary.byStyle.photo_ask.replyRate)} | Booking ask {formatPercent(summary.byStyle.booking_ask.replyRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {summary.learned.keepShort ? "Short openers are winning." : "No strong short-opener edge yet."}
        {" | "}
        {summary.learned.keepSingleAsk ? "One clear ask is performing better." : "No strong single-ask edge yet."}
        {" | "}
        {summary.learned.openWithPhotoAsk ? "Photo-first openers are working better." : "No strong photo-first edge yet."}
        {" | "}
        {summary.learned.avoidHardBookingAsk ? "Hard booking asks are underperforming on first touch." : "No strong hard-booking warning yet."}
      </div>
    </div>
  );
}

function renderQuoteAccuracyLearning(
  label: string,
  summary: QuoteAccuracySliceDto,
): React.ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="font-semibold text-slate-900">{label}</div>
      <div className="mt-1 text-[11px] text-slate-600">
        Completed jobs: {summary.attempts} | Within range: {summary.withinRange} (
        {formatPercent(summary.withinRangeRate)})
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Above range {formatPercent(summary.aboveRangeRate)} | Below range {formatPercent(summary.belowRangeRate)}
      </div>
      <div className="text-[11px] text-slate-500">
        High-confidence within range {formatPercent(summary.byConfidence.high.withinRangeRate)} | Low-confidence{" "}
        {formatPercent(summary.byConfidence.low.withinRangeRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Avg miss outside range: {formatUsdCents(summary.averageOutsideByCents)}
      </div>
    </div>
  );
}

function renderObjectionLearning(
  label: string,
  summary: ObjectionSummaryDto["byType"]["price"],
): React.ReactElement {
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
        Attempts: {summary.attempts} | Reopened: {summary.reopened} ({formatPercent(summary.reopenRate)})
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        SMS reopen {formatPercent(summary.byChannel.sms.reopenRate)} | Messenger reopen{" "}
        {formatPercent(summary.byChannel.dm.reopenRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {preferredChannel ? `Learned channel lean: ${preferredChannel}` : "Learned channel lean: not strong enough yet"}
        {" | "}
        {summary.learned.keepSofter ? "Softer save is safer." : "No strong softer-save warning yet."}
      </div>
    </div>
  );
}

function renderQuoteHotWindowLearning(
  label: string,
  summary: QuoteHotWindowSliceDto,
): React.ReactElement {
  const hotWindow =
    summary.learned.hotWindow === "under_6h"
      ? "Under 6 hours"
      : summary.learned.hotWindow === "same_day"
        ? "Same day"
        : summary.learned.hotWindow === "day_1_3"
          ? "1 to 3 days"
          : summary.learned.hotWindow === "slow_burn"
            ? "Slow burn"
            : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="font-semibold text-slate-900">{label}</div>
      <div className="mt-1 text-[11px] text-slate-600">
        Quotes: {summary.quotes} | Booked: {summary.bookedQuotes} ({formatPercent(summary.bookRate)})
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Under 6h {formatPercent(summary.byWindow.under_6h.bookRate)} | Same day {formatPercent(summary.byWindow.same_day.bookRate)}
      </div>
      <div className="text-[11px] text-slate-500">
        1 to 3 days {formatPercent(summary.byWindow.day_1_3.bookRate)} | After 3 days {formatPercent(summary.byWindow.after_3d.bookRate)}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {hotWindow ? `Learned hot window: ${hotWindow}` : "Learned hot window: not strong enough yet"}
        {" | "}
        {summary.learned.urgencyDecayFast ? "Urgency decays fast after the hot window." : "No strong urgency-decay warning yet."}
        {" | "}
        {summary.learned.sameDayStillStrong ? "Same-day quotes are still closing strongly." : "No strong same-day hold yet."}
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
    appointmentPreservationSummary?: AppointmentPreservationSummaryDto;
    appointmentReminderSummary?: AppointmentReminderSummaryDto;
    channelHandoffSummary?: ChannelHandoffSummaryDto;
    firstResponseSummary?: FirstResponseSummaryDto;
    missingInfoSummary?: MissingInfoSummaryDto;
    objectionSummary?: ObjectionSummaryDto;
    quoteAccuracySummary?: QuoteAccuracySummaryDto;
    quoteHotWindowSummary?: QuoteHotWindowSummaryDto;
    quoteCloseSummary?: QuoteCloseSummaryDto;
    followupSummary?: FollowupSummaryDto;
    reactivationSummary?: ReactivationSummaryDto;
  };
  const quotes = data.quotes ?? [];
  const summary = data.summary;
  const appointmentPreservationSummary = data.appointmentPreservationSummary;
  const appointmentReminderSummary = data.appointmentReminderSummary;
  const channelHandoffSummary = data.channelHandoffSummary;
  const firstResponseSummary = data.firstResponseSummary;
  const missingInfoSummary = data.missingInfoSummary;
  const objectionSummary = data.objectionSummary;
  const quoteAccuracySummary = data.quoteAccuracySummary;
  const quoteHotWindowSummary = data.quoteHotWindowSummary;
  const quoteCloseSummary = data.quoteCloseSummary;
  const followupSummary = data.followupSummary;
  const reactivationSummary = data.reactivationSummary;

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
      {quoteHotWindowSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Quote hot-window learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks how long different quote segments stay hot before booking rates fall off, so the planner can tune urgency instead of using one generic pace.
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {renderQuoteHotWindowLearning("Overall", quoteHotWindowSummary)}
            {renderQuoteHotWindowLearning("Junk quotes", quoteHotWindowSummary.byServiceFamily.junk)}
            {renderQuoteHotWindowLearning("Demo quotes", quoteHotWindowSummary.byServiceFamily.demo)}
            {renderQuoteHotWindowLearning("Brush quotes", quoteHotWindowSummary.byServiceFamily.brush)}
            {renderQuoteHotWindowLearning("Facebook-sourced", quoteHotWindowSummary.bySourceFamily.facebook)}
            {renderQuoteHotWindowLearning("Public-site sourced", quoteHotWindowSummary.bySourceFamily.public_site)}
          </div>
        </div>
      ) : null}
      {firstResponseSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">First-response learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks the first real outbound touch after a new lead arrives and measures whether it turns into a live conversation and eventually books.
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {renderFirstResponseLearning("Overall", firstResponseSummary)}
            {renderFirstResponseLearning("Junk leads", firstResponseSummary.byServiceFamily.junk)}
            {renderFirstResponseLearning("Demo leads", firstResponseSummary.byServiceFamily.demo)}
            {renderFirstResponseLearning("Brush leads", firstResponseSummary.byServiceFamily.brush)}
            {renderFirstResponseLearning("Facebook-sourced", firstResponseSummary.bySourceFamily.facebook)}
            {renderFirstResponseLearning("Public-site sourced", firstResponseSummary.bySourceFamily.public_site)}
          </div>
        </div>
      ) : null}
      {channelHandoffSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Messenger handoff learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real Messenger to SMS handoffs and whether they reopened the lead, actually shifted the conversation into text, and still booked.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {channelHandoffSummary.attempts} | Reopened: {channelHandoffSummary.reopened} (
            {formatPercent(channelHandoffSummary.reopenRate)}) | Booked later: {channelHandoffSummary.booked} (
            {formatPercent(channelHandoffSummary.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Shifted into SMS {formatPercent(channelHandoffSummary.smsTransitionRate)} | Stayed in Messenger{" "}
            {formatPercent(channelHandoffSummary.stayDmRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {channelHandoffSummary.learned.smsTransitionHealthy
              ? "Messenger to SMS handoffs are carrying into text reliably enough right now."
              : "No strong SMS-transition health signal yet."}
            {" | "}
            {channelHandoffSummary.learned.keepLighter
              ? "Keep handoffs light. Hard transitions are stalling too often."
              : "No strong keep-it-light warning yet."}
            {" | "}
            {channelHandoffSummary.learned.worthHandoff
              ? "Messenger to SMS handoff is still worth using on the right quiet leads."
              : "Messenger to SMS handoff is underperforming enough that it should stay selective."}
          </div>
        </div>
      ) : null}
      {reactivationSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Dormant-lead reactivation learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real outbound follow-ups sent after at least 24 hours of silence and measures whether they reopen the conversation or eventually book.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {reactivationSummary.attempts} | Reopened: {reactivationSummary.reopened} (
            {formatPercent(reactivationSummary.reopenRate)}) | Booked later: {reactivationSummary.booked} (
            {formatPercent(reactivationSummary.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            SMS reopen {formatPercent(reactivationSummary.byChannel.sms.reopenRate)} | Messenger reopen{" "}
            {formatPercent(reactivationSummary.byChannel.dm.reopenRate)} | Email reopen{" "}
            {formatPercent(reactivationSummary.byChannel.email.reopenRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            1 to 3 day silence reopen {formatPercent(reactivationSummary.byDormancy.day_1_3.reopenRate)} | 3 plus day silence reopen{" "}
            {formatPercent(reactivationSummary.byDormancy.day_3_plus.reopenRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {reactivationSummary.learned.preferredChannel === "sms"
              ? "Learned reactivation lean: SMS"
              : reactivationSummary.learned.preferredChannel === "dm"
                ? "Learned reactivation lean: Messenger"
                : "Learned reactivation lean: not strong enough yet"}
            {" | "}
            {reactivationSummary.learned.keepSofter
              ? "Softer reopen touches are safer right now."
              : "No strong softer-reactivation warning yet."}
            {" | "}
            {reactivationSummary.learned.worthReactivating
              ? "Dormant leads are still worth reviving."
              : "Dormant lead reactivations are weak right now, so keep them low pressure."}
          </div>
        </div>
      ) : null}
      {quoteAccuracySummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Quote accuracy learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This compares completed jobs linked to instant quotes against the original displayed quote range, so the agent can learn when instant estimates are trustworthy versus when they should stay softer.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Completed jobs: {quoteAccuracySummary.attempts} | Finished inside range: {quoteAccuracySummary.withinRange} (
            {formatPercent(quoteAccuracySummary.withinRangeRate)}) | Above range: {quoteAccuracySummary.aboveRange} (
            {formatPercent(quoteAccuracySummary.aboveRangeRate)}) | Below range: {quoteAccuracySummary.belowRange} (
            {formatPercent(quoteAccuracySummary.belowRangeRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            High-confidence within range {formatPercent(quoteAccuracySummary.byConfidence.high.withinRangeRate)} | Medium{" "}
            {formatPercent(quoteAccuracySummary.byConfidence.medium.withinRangeRate)} | Low{" "}
            {formatPercent(quoteAccuracySummary.byConfidence.low.withinRangeRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Average miss when outside range: {formatUsdCents(quoteAccuracySummary.averageOutsideByCents)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {quoteAccuracySummary.learned.highConfidenceTrustworthy
              ? "High-confidence instant estimates are holding up well."
              : "No strong high-confidence trust signal yet."}
            {" | "}
            {quoteAccuracySummary.learned.lowConfidenceNeedsTightening
              ? "Lower-confidence instant estimates should usually be tightened first."
              : "No strong low-confidence tightening warning yet."}
            {" | "}
            {quoteAccuracySummary.learned.keepQuoteProvisional
              ? "Shakier quotes should stay framed as working estimates."
              : "No strong provisional-quote warning yet."}
            {" | "}
            {quoteAccuracySummary.learned.tendsAboveRange
              ? "Completed jobs are skewing above the original instant range."
              : "No strong above-range skew yet."}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {renderQuoteAccuracyLearning("Junk quotes", quoteAccuracySummary.byServiceFamily.junk)}
            {renderQuoteAccuracyLearning("Demo quotes", quoteAccuracySummary.byServiceFamily.demo)}
            {renderQuoteAccuracyLearning("Brush quotes", quoteAccuracySummary.byServiceFamily.brush)}
            {renderQuoteAccuracyLearning("Facebook-sourced", quoteAccuracySummary.bySourceFamily.facebook)}
            {renderQuoteAccuracyLearning("Public-site sourced", quoteAccuracySummary.bySourceFamily.public_site)}
          </div>
        </div>
      ) : null}
      {quoteCloseSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Quote close learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real agent-driven quote follow-ups and measures whether they turned into booked jobs or ended in lost dispositions within 14 days.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {quoteCloseSummary.attempts} | Booked: {quoteCloseSummary.booked} (
            {formatPercent(quoteCloseSummary.bookRate)}) | Lost: {quoteCloseSummary.lost} (
            {formatPercent(quoteCloseSummary.lostRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            SMS book {formatPercent(quoteCloseSummary.byChannel.sms.bookRate)} | Messenger book{" "}
            {formatPercent(quoteCloseSummary.byChannel.dm.bookRate)} | Email book{" "}
            {formatPercent(quoteCloseSummary.byChannel.email.bookRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            SMS lost {formatPercent(quoteCloseSummary.byChannel.sms.lostRate)} | Messenger lost{" "}
            {formatPercent(quoteCloseSummary.byChannel.dm.lostRate)} | Email lost{" "}
            {formatPercent(quoteCloseSummary.byChannel.email.lostRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {quoteCloseSummary.learned.preferredChannel === "sms"
              ? "Learned quote-close lean: SMS"
              : quoteCloseSummary.learned.preferredChannel === "dm"
                ? "Learned quote-close lean: Messenger"
                : "Learned quote-close lean: not strong enough yet"}
            {" | "}
            {quoteCloseSummary.learned.keepSofter
              ? "Hard booking pushes are underperforming right now."
              : "No strong softer-close warning yet."}
          </div>
        </div>
      ) : null}
      {objectionSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Objection-save learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real sent price-objection save attempts and whether they reopened the conversation within 48 hours.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {objectionSummary.attempts} | Reopened: {objectionSummary.reopened} (
            {formatPercent(objectionSummary.reopenRate)}) | Booked later: {objectionSummary.booked} (
            {formatPercent(objectionSummary.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            SMS reopen {formatPercent(objectionSummary.byChannel.sms.reopenRate)} | Messenger reopen{" "}
            {formatPercent(objectionSummary.byChannel.dm.reopenRate)} | Email reopen{" "}
            {formatPercent(objectionSummary.byChannel.email.reopenRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {objectionSummary.learned.preferredChannel === "sms"
              ? "Learned objection-save lean: SMS"
              : objectionSummary.learned.preferredChannel === "dm"
                ? "Learned objection-save lean: Messenger"
                : "Learned objection-save lean: not strong enough yet"}
            {" | "}
            {objectionSummary.learned.keepSofter
              ? "Low-pressure reopens are safer right now."
              : "No strong softer-save warning yet."}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {renderObjectionLearning("Price only", objectionSummary.byType.price)}
            {renderObjectionLearning("Comparison shopping", objectionSummary.byType.comparison_shopping)}
            {renderObjectionLearning("Decision maker", objectionSummary.byType.decision_maker)}
            {renderObjectionLearning("Timing hesitation", objectionSummary.byType.timing)}
          </div>
        </div>
      ) : null}
      {missingInfoSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Missing-info learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real sent missing-detail requests and whether the customer actually sent back the needed info within 48 hours.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {missingInfoSummary.attempts} | Resolved: {missingInfoSummary.resolved} (
            {formatPercent(missingInfoSummary.resolutionRate)}) | Booked later: {missingInfoSummary.booked} (
            {formatPercent(missingInfoSummary.bookRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Resolved with media {formatPercent(missingInfoSummary.mediaResolutionRate)} | Resolved with text{" "}
            {formatPercent(missingInfoSummary.textResolutionRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            SMS resolve {formatPercent(missingInfoSummary.byChannel.sms.resolutionRate)} | Messenger resolve{" "}
            {formatPercent(missingInfoSummary.byChannel.dm.resolutionRate)} | Email resolve{" "}
            {formatPercent(missingInfoSummary.byChannel.email.resolutionRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {missingInfoSummary.learned.preferredChannel === "sms"
              ? "Learned missing-info lean: SMS"
              : missingInfoSummary.learned.preferredChannel === "dm"
                ? "Learned missing-info lean: Messenger"
                : "Learned missing-info lean: not strong enough yet"}
            {" | "}
            {missingInfoSummary.learned.keepSingleAsk
              ? "Single specific asks are safer right now."
              : "No strong single-ask warning yet."}
            {" | "}
            {missingInfoSummary.learned.leanIntoRequests
              ? "Missing-detail requests are resolving well enough to use when they unblock the estimate."
              : "No strong push toward extra missing-detail asks yet."}
          </div>
        </div>
      ) : null}
      {appointmentReminderSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Appointment reminder learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real appointment reminder texts, how often they get acknowledged, and whether reschedule requests are getting preserved instead of turning into lost jobs.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {appointmentReminderSummary.attempts} | Acknowledged: {appointmentReminderSummary.acknowledged} (
            {formatPercent(appointmentReminderSummary.acknowledgedRate)}) | No-shows: {appointmentReminderSummary.noShows} (
            {formatPercent(appointmentReminderSummary.noShowRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Confirm replies {formatPercent(appointmentReminderSummary.confirmRate)} | Reschedule requests{" "}
            {formatPercent(appointmentReminderSummary.rescheduleRequestRate)} | Rescheduled after request{" "}
            {formatPercent(appointmentReminderSummary.rescheduleSaveRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            24h reminder ack {formatPercent(appointmentReminderSummary.byWindow["24h"].acknowledgedRate)} | 2h reminder ack{" "}
            {formatPercent(appointmentReminderSummary.byWindow["2h"].acknowledgedRate)} | Completed after reminder{" "}
            {formatPercent(appointmentReminderSummary.completedRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {appointmentReminderSummary.learned.preferredWindow === "24h"
              ? "Learned reminder-window lean: 24h"
              : appointmentReminderSummary.learned.preferredWindow === "2h"
                ? "Learned reminder-window lean: 2h"
                : "Learned reminder-window lean: not strong enough yet"}
            {" | "}
            {appointmentReminderSummary.learned.confirmationLoopHealthy
              ? "Confirmation loop is healthy right now."
              : "Confirmation loop still needs human backup on shakier appointments."}
            {" | "}
            {appointmentReminderSummary.learned.rescheduleSavesWorking
              ? "Reschedule saves are preserving booked work."
              : "No strong reschedule-save edge yet."}
          </div>
        </div>
      ) : null}
      {appointmentPreservationSummary ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
          <div className="font-semibold text-slate-900">Appointment preservation learning</div>
          <div className="mt-1 text-[11px] text-slate-500">
            This tracks real post-booking confirmation-loop touches and measures which ones correlate with kept jobs versus cancellations and no-shows.
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            Attempts: {appointmentPreservationSummary.attempts} | Preserved: {appointmentPreservationSummary.preserved} (
            {formatPercent(appointmentPreservationSummary.preservedRate)}) | Completed: {appointmentPreservationSummary.completed} (
            {formatPercent(appointmentPreservationSummary.completedRate)})
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Canceled {formatPercent(appointmentPreservationSummary.canceledRate)} | No-show {formatPercent(appointmentPreservationSummary.noShowRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Initial confirmation preserve {formatPercent(appointmentPreservationSummary.byKind.requested.preservedRate)} | Reschedule confirmation preserve{" "}
            {formatPercent(appointmentPreservationSummary.byKind.rescheduled.preservedRate)} | Reminder preserve{" "}
            {formatPercent(appointmentPreservationSummary.byKind.reminder.preservedRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Estimate preserve {formatPercent(appointmentPreservationSummary.byAppointmentType.estimate.preservedRate)} | In person quote{" "}
            {formatPercent(appointmentPreservationSummary.byAppointmentType.in_person_quote.preservedRate)} | Job{" "}
            {formatPercent(appointmentPreservationSummary.byAppointmentType.job.preservedRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Junk preserve {formatPercent(appointmentPreservationSummary.byServiceFamily.junk.preservedRate)} | Demo{" "}
            {formatPercent(appointmentPreservationSummary.byServiceFamily.demo.preservedRate)} | Brush{" "}
            {formatPercent(appointmentPreservationSummary.byServiceFamily.brush.preservedRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Facebook preserve {formatPercent(appointmentPreservationSummary.bySourceFamily.facebook.preservedRate)} | Public-site{" "}
            {formatPercent(appointmentPreservationSummary.bySourceFamily.public_site.preservedRate)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {appointmentPreservationSummary.learned.strongestTouchKind === "requested"
              ? "Learned appointment-preservation lean: initial confirmations"
              : appointmentPreservationSummary.learned.strongestTouchKind === "rescheduled"
                ? "Learned appointment-preservation lean: reschedule confirmations"
                : appointmentPreservationSummary.learned.strongestTouchKind === "reminder"
                  ? "Learned appointment-preservation lean: pre-job reminders"
                  : "Learned appointment-preservation lean: not strong enough yet"}
            {" | "}
            {appointmentPreservationSummary.learned.needsHumanBackup
              ? "Booked jobs still need human backup on shakier appointments."
              : "No strong human-backup warning yet."}
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
