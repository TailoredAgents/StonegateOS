import { z } from "zod";

const count = z.number().finite().int().nonnegative();
const rate = z.number().finite().min(0).max(1);
const amount = z.number().finite().nonnegative();
const timestamp = z.string().min(1);
const preferredChannel = z.enum(["sms", "dm"]).nullable();

function channels<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ sms: schema, dm: schema, email: schema });
}

function serviceFamilies<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    junk: schema,
    demo: schema,
    brush: schema,
    unknown: schema,
  });
}

function sourceFamilies<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    facebook: schema,
    public_site: schema,
    other: schema,
    unknown: schema,
  });
}

const mediaQuoteBucket = z.object({
  quotes: count,
  bookedQuotes: count,
  bookRate: rate,
});

const mediaSummary = z.object({
  windowStart: timestamp,
  totalQuotes: count,
  bookedQuotes: count,
  mediaInformed: mediaQuoteBucket.extend({
    highConfidence: mediaQuoteBucket,
    lowConfidence: mediaQuoteBucket,
    missingViews: mediaQuoteBucket,
    weakQuotes: mediaQuoteBucket,
    tightenedAfterMoreMedia: mediaQuoteBucket,
    unresolvedWeakMedia: mediaQuoteBucket,
  }),
  standard: mediaQuoteBucket,
});

const firstResponseBucket = z.object({
  attempts: count,
  replied: count,
  replyRate: rate,
  booked: count,
  bookRate: rate,
});

const firstResponseSlice = z.object({
  attempts: count,
  replied: count,
  replyRate: rate,
  booked: count,
  bookRate: rate,
  byChannel: channels(firstResponseBucket),
  byTiming: z.object({
    fast: firstResponseBucket,
    delayed: firstResponseBucket,
  }),
  byStyle: z.object({
    short: firstResponseBucket,
    long: firstResponseBucket,
    single_ask: firstResponseBucket,
    multi_ask: firstResponseBucket,
    photo_ask: firstResponseBucket,
    booking_ask: firstResponseBucket,
  }),
  learned: z.object({
    preferredChannel,
    preferFast: z.boolean(),
    keepShort: z.boolean(),
    keepSingleAsk: z.boolean(),
    openWithPhotoAsk: z.boolean(),
    avoidHardBookingAsk: z.boolean(),
  }),
});

const firstResponseSummary = firstResponseSlice.extend({
  windowStart: timestamp,
  byServiceFamily: serviceFamilies(firstResponseSlice),
  bySourceFamily: sourceFamilies(firstResponseSlice),
});

const channelHandoffSummary = z.object({
  windowStart: timestamp,
  attempts: count,
  reopened: count,
  reopenRate: rate,
  transitionedToSms: count,
  smsTransitionRate: rate,
  stayedInDm: count,
  stayDmRate: rate,
  booked: count,
  bookRate: rate,
  learned: z.object({
    worthHandoff: z.boolean(),
    keepLighter: z.boolean(),
    smsTransitionHealthy: z.boolean(),
  }),
});

const followupBucket = z.object({
  quotes: count,
  bookedQuotes: count,
  bookRate: rate,
});

const followupSlice = z.object({
  quotesWithFollowup: count,
  bookedQuotes: count,
  byChannel: channels(followupBucket),
  byTiming: z.object({ fast: followupBucket, delayed: followupBucket }),
  byDepth: z.object({
    first: followupBucket,
    second: followupBucket,
    third_plus: followupBucket,
  }),
  byStyle: z.object({
    short: followupBucket,
    long: followupBucket,
    single_ask: followupBucket,
    multi_ask: followupBucket,
    photo_ask: followupBucket,
    booking_ask: followupBucket,
  }),
  learned: z.object({
    preferredChannel,
    preferFast: z.boolean(),
    secondTouchStillWorthwhile: z.boolean(),
    thirdPlusWorthwhile: z.boolean(),
    keepDepthLight: z.boolean(),
    keepShort: z.boolean(),
    keepSingleAsk: z.boolean(),
    openWithPhotoAsk: z.boolean(),
    avoidHardBookingAsk: z.boolean(),
  }),
});

const followupSummary = followupSlice.extend({
  windowStart: timestamp,
  byServiceFamily: serviceFamilies(followupSlice),
  bySourceFamily: sourceFamilies(followupSlice),
});

const objectionBucket = z.object({
  attempts: count,
  reopened: count,
  reopenRate: rate,
  booked: count,
  bookRate: rate,
});

const objectionType = objectionBucket.extend({
  byChannel: channels(objectionBucket),
  learned: z.object({
    preferredChannel,
    keepSofter: z.boolean(),
  }),
});

const objectionSummary = objectionBucket.extend({
  windowStart: timestamp,
  byChannel: channels(objectionBucket),
  byType: z.object({
    price: objectionType,
    comparison_shopping: objectionType,
    decision_maker: objectionType,
    timing: objectionType,
  }),
  learned: z.object({
    preferredChannel,
    keepSofter: z.boolean(),
  }),
});

const missingInfoBucket = z.object({
  attempts: count,
  resolved: count,
  resolutionRate: rate,
  resolvedWithMedia: count,
  mediaResolutionRate: rate,
  resolvedWithText: count,
  textResolutionRate: rate,
  booked: count,
  bookRate: rate,
});

const missingInfoSummary = missingInfoBucket.extend({
  windowStart: timestamp,
  byChannel: channels(missingInfoBucket),
  learned: z.object({
    preferredChannel,
    keepSingleAsk: z.boolean(),
    leanIntoRequests: z.boolean(),
  }),
});

const appointmentReminderBucket = z.object({
  attempts: count,
  acknowledged: count,
  acknowledgedRate: rate,
  confirmedReplies: count,
  confirmRate: rate,
  rescheduleRequests: count,
  rescheduleRequestRate: rate,
  rescheduled: count,
  rescheduleSaveRate: rate,
  activeAppointments: count,
  activeRate: rate,
  completed: count,
  completedRate: rate,
  noShows: count,
  noShowRate: rate,
});

const appointmentReminderSummary = appointmentReminderBucket.extend({
  windowStart: timestamp,
  byWindow: z.object({
    "24h": appointmentReminderBucket,
    "2h": appointmentReminderBucket,
    other: appointmentReminderBucket,
  }),
  learned: z.object({
    preferredWindow: z.enum(["24h", "2h", "other"]).nullable(),
    confirmationLoopHealthy: z.boolean(),
    rescheduleSavesWorking: z.boolean(),
  }),
});

const appointmentPreservationBucket = z.object({
  attempts: count,
  preserved: count,
  preservedRate: rate,
  completed: count,
  completedRate: rate,
  canceled: count,
  canceledRate: rate,
  noShows: count,
  noShowRate: rate,
});

const appointmentPreservationSummary = appointmentPreservationBucket.extend({
  windowStart: timestamp,
  byKind: z.object({
    requested: appointmentPreservationBucket,
    rescheduled: appointmentPreservationBucket,
    reminder: appointmentPreservationBucket,
    other: appointmentPreservationBucket,
  }),
  byAppointmentType: z.object({
    estimate: appointmentPreservationBucket,
    in_person_quote: appointmentPreservationBucket,
    job: appointmentPreservationBucket,
    other: appointmentPreservationBucket,
  }),
  byServiceFamily: serviceFamilies(appointmentPreservationBucket),
  bySourceFamily: sourceFamilies(appointmentPreservationBucket),
  learned: z.object({
    strongestTouchKind: z
      .enum(["requested", "rescheduled", "reminder", "other"])
      .nullable(),
    needsHumanBackup: z.boolean(),
  }),
});

const closeLoopBucket = z.object({
  attempts: count,
  replied: count,
  replyRate: rate,
  preserved: count,
  preservedRate: rate,
  completed: count,
  completedRate: rate,
  rescheduled: count,
  rescheduleRate: rate,
  repeatBooked: count,
  repeatBookRate: rate,
});

const closeLoopSlice = closeLoopBucket.extend({
  byAction: z.object({
    appointment_checkin: closeLoopBucket,
    appointment_support: closeLoopBucket,
    post_job_checkin: closeLoopBucket,
  }),
  learned: z.object({
    appointmentCheckinWorthwhile: z.boolean(),
    appointmentSupportWorthwhile: z.boolean(),
    appointmentSupportNeedsLightTouch: z.boolean(),
    postJobCheckinWorthwhile: z.boolean(),
  }),
});

const closeLoopSummary = closeLoopSlice.extend({
  windowStart: timestamp,
  byServiceFamily: serviceFamilies(closeLoopSlice),
  bySourceFamily: sourceFamilies(closeLoopSlice),
});

const hotWindowBucket = z.object({
  quotes: count,
  bookedQuotes: count,
  bookRate: rate,
});

const hotWindowSlice = hotWindowBucket.extend({
  byWindow: z.object({
    under_6h: hotWindowBucket,
    same_day: hotWindowBucket,
    day_1_3: hotWindowBucket,
    after_3d: hotWindowBucket,
  }),
  learned: z.object({
    hotWindow: z
      .enum(["under_6h", "same_day", "day_1_3", "slow_burn"])
      .nullable(),
    urgencyDecayFast: z.boolean(),
    sameDayStillStrong: z.boolean(),
  }),
});

const hotWindowSummary = hotWindowSlice.extend({
  windowStart: timestamp,
  byServiceFamily: serviceFamilies(hotWindowSlice),
  bySourceFamily: sourceFamilies(hotWindowSlice),
});

const reactivationBucket = z.object({
  attempts: count,
  reopened: count,
  reopenRate: rate,
  booked: count,
  bookRate: rate,
});

const reactivationSummary = reactivationBucket.extend({
  windowStart: timestamp,
  byChannel: channels(reactivationBucket),
  byDormancy: z.object({
    day_1_3: reactivationBucket,
    day_3_plus: reactivationBucket,
  }),
  learned: z.object({
    preferredChannel,
    keepSofter: z.boolean(),
    worthReactivating: z.boolean(),
  }),
});

const quoteCloseBucket = z.object({
  attempts: count,
  booked: count,
  bookRate: rate,
  lost: count,
  lostRate: rate,
});

const quoteCloseSummary = quoteCloseBucket.extend({
  windowStart: timestamp,
  byChannel: channels(quoteCloseBucket),
  learned: z.object({
    preferredChannel,
    keepSofter: z.boolean(),
  }),
});

const quoteAccuracyBucket = z.object({
  quotes: count,
  withinRange: count,
  withinRangeRate: rate,
  aboveRange: count,
  aboveRangeRate: rate,
  belowRange: count,
  belowRangeRate: rate,
  averageOutsideByCents: amount,
});

const quoteAccuracySlice = z.object({
  attempts: count,
  withinRange: count,
  withinRangeRate: rate,
  aboveRange: count,
  aboveRangeRate: rate,
  belowRange: count,
  belowRangeRate: rate,
  averageOutsideByCents: amount,
  byConfidence: z.object({
    high: quoteAccuracyBucket,
    medium: quoteAccuracyBucket,
    low: quoteAccuracyBucket,
    unknown: quoteAccuracyBucket,
  }),
  learned: z.object({
    lowConfidenceNeedsTightening: z.boolean(),
    keepQuoteProvisional: z.boolean(),
    tendsAboveRange: z.boolean(),
    highConfidenceTrustworthy: z.boolean(),
  }),
});

const quoteAccuracySummary = quoteAccuracySlice.extend({
  windowStart: timestamp,
  byServiceFamily: serviceFamilies(quoteAccuracySlice),
  bySourceFamily: sourceFamilies(quoteAccuracySlice),
});

const instantQuote = z.object({
  id: z.string().uuid(),
  createdAt: timestamp,
  contactName: z.string(),
  contactPhone: z.string(),
  timeframe: z.string(),
  zip: z.string(),
  jobTypes: z.array(z.string()),
  perceivedSize: z.string(),
  photoCount: count,
  aiResult: z.object({
    loadFractionEstimate: amount,
    priceLow: amount,
    priceHigh: amount,
    priceLowDiscounted: amount.optional(),
    priceHighDiscounted: amount.optional(),
    discountPercent: rate.optional(),
    addOnTotal: amount.optional(),
    displayTierLabel: z.string(),
    reasonSummary: z.string(),
    needsInPersonEstimate: z.boolean(),
    mediaAnalysis: z
      .object({
        visibleVolumeRange: z.string().optional(),
        mergedVolumeRange: z.string().optional(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
      .optional(),
  }),
  isMediaInformed: z.boolean().optional(),
  hasBookedAppointment: z.boolean().optional(),
  tightenedAfterMoreMedia: z.boolean().optional(),
});

export const instantQuoteListResponseSchema = z.object({
  quotes: z.array(instantQuote),
  summary: mediaSummary,
  appointmentPreservationSummary,
  appointmentReminderSummary,
  channelHandoffSummary,
  closeLoopSummary,
  firstResponseSummary,
  missingInfoSummary,
  objectionSummary,
  quoteAccuracySummary,
  quoteHotWindowSummary: hotWindowSummary,
  quoteCloseSummary,
  followupSummary,
  reactivationSummary,
});

export function parseInstantQuoteListResponse(value: unknown) {
  return instantQuoteListResponseSchema.safeParse(value);
}
