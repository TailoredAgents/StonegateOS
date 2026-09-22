"use client";

import { useEffect } from "react";
import type * as React from "react";
import { Button, cn } from "@myst-os/ui";
import { ShieldCheck } from "lucide-react";
import type {
  AvailabilityDay,
  AvailabilitySlot,
  QuoteMediaAnalysis,
  QuoteState,
} from "./lead-form-types";

export default function LeadFormQuoteResult({
  quoteState,
  quoteCardRef,
  onReady,
  discountLabel,
  discountedRange,
  baseRange,
  isDemo,
  junkWeightLabel,
  junkEstimateDisclaimer,
  quoteMediaAnalysis,
  quoteVisibleRangeLabel,
  quoteMergedRangeLabel,
  quoteRangeWasWidened,
  quoteAddOnSummary,
  quoteNeedsMorePhotos,
  showBookingDetails,
  setShowBookingDetails,
  textEstimateMessage,
  setTextEstimateMessage,
  addressLine1,
  setAddressLine1,
  city,
  setCity,
  stateField,
  setStateField,
  postalCode,
  setPostalCode,
  addressComplete,
  availabilityStatus,
  availabilityMessage,
  availabilityDurationMinutes,
  availabilitySlots,
  availabilityDays,
  availabilitySelectedDay,
  setAvailabilitySelectedDay,
  selectedSlotStartAt,
  setSelectedSlotStartAt,
  availabilityShowMore,
  setAvailabilityShowMore,
  holdStatus,
  holdExpiresAt,
  holdMessage,
  bookingStatus,
  bookingMessage,
  fetchAvailability,
  submitBooking,
  formatSlotLabel,
  formatSlotTimeLabel,
  formatHoldExpiry,
  formatDayLabel,
}: {
  quoteState: QuoteState;
  quoteCardRef: React.RefObject<HTMLDivElement | null>;
  onReady: () => void;
  discountLabel: string | null;
  discountedRange: string | null;
  baseRange: string | null;
  isDemo: boolean;
  junkWeightLabel: string | null;
  junkEstimateDisclaimer: string | null;
  quoteMediaAnalysis: QuoteMediaAnalysis;
  quoteVisibleRangeLabel: string | null;
  quoteMergedRangeLabel: string | null;
  quoteRangeWasWidened: boolean;
  quoteAddOnSummary: string;
  quoteNeedsMorePhotos: boolean;
  showBookingDetails: boolean;
  setShowBookingDetails: React.Dispatch<React.SetStateAction<boolean>>;
  textEstimateMessage: string | null;
  setTextEstimateMessage: React.Dispatch<React.SetStateAction<string | null>>;
  addressLine1: string;
  setAddressLine1: React.Dispatch<React.SetStateAction<string>>;
  city: string;
  setCity: React.Dispatch<React.SetStateAction<string>>;
  stateField: string;
  setStateField: React.Dispatch<React.SetStateAction<string>>;
  postalCode: string;
  setPostalCode: React.Dispatch<React.SetStateAction<string>>;
  addressComplete: boolean;
  availabilityStatus: "idle" | "loading" | "ready" | "error";
  availabilityMessage: string | null;
  availabilityDurationMinutes: number | null;
  availabilitySlots: AvailabilitySlot[];
  availabilityDays: AvailabilityDay[];
  availabilitySelectedDay: string | null;
  setAvailabilitySelectedDay: React.Dispatch<
    React.SetStateAction<string | null>
  >;
  selectedSlotStartAt: string | null;
  setSelectedSlotStartAt: React.Dispatch<React.SetStateAction<string | null>>;
  availabilityShowMore: boolean;
  setAvailabilityShowMore: React.Dispatch<React.SetStateAction<boolean>>;
  holdStatus: "idle" | "loading" | "ready" | "error";
  holdExpiresAt: string | null;
  holdMessage: string | null;
  bookingStatus: "idle" | "loading" | "success" | "error";
  bookingMessage: string | null;
  fetchAvailability: () => Promise<void>;
  submitBooking: () => Promise<void>;
  formatSlotLabel: (iso: string) => string;
  formatSlotTimeLabel: (iso: string) => string;
  formatHoldExpiry: (iso: string) => string;
  formatDayLabel: (dayIso: string) => string;
}) {
  // Wait for the lazy result to mount before scrolling its card into view.
  useEffect(() => {
    if (quoteState.status === "ready") onReady();
  }, [onReady, quoteState.status]);

  if (quoteState.status === "error") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {quoteState.message}
      </div>
    );
  }

  if (quoteState.status !== "ready") return null;

  return (
    <div
      ref={quoteCardRef}
      className="scroll-mt-40 space-y-4 rounded-lg border border-neutral-200 bg-white p-4 shadow-soft shadow-primary-900/10"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-primary-900">
            Here&apos;s your estimate
          </div>
          {discountLabel ? (
            <span className="rounded-full bg-primary-800 px-2.5 py-1 text-[11px] font-bold uppercase text-white">
              {discountLabel}
            </span>
          ) : null}
          {!isDemo && junkWeightLabel ? (
            <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] font-semibold text-neutral-700">
              {junkWeightLabel}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <div className="text-4xl font-semibold leading-none text-primary-900">
            {discountedRange}
          </div>
          {discountLabel && baseRange ? (
            <div className="pb-0.5 text-base font-medium text-neutral-400 line-through">
              {baseRange}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-700">
          <span className="font-semibold text-neutral-900">
            {quoteState.tier}
          </span>
          <span className="text-neutral-300">|</span>
          <span>Estimate saved</span>
        </div>
      </div>
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm leading-relaxed text-neutral-700">
        {quoteState.reason}
      </div>
      {!isDemo && junkEstimateDisclaimer ? (
        <div className="flex gap-2 rounded-md border border-primary-100 bg-primary-50/70 px-3 py-2 text-xs leading-relaxed text-primary-900">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-primary-700"
            aria-hidden="true"
          />
          <div>
            <div className="font-semibold">
              Final price confirmed before loading
            </div>
            <div>
              We review the job in person first. The estimate only changes if
              volume, weight, access, or materials differ from what was entered.
            </div>
          </div>
        </div>
      ) : null}
      {!isDemo && quoteMediaAnalysis ? (
        <div className="space-y-2 rounded-md border border-primary-100 bg-white/70 px-3 py-2 text-xs text-neutral-700">
          {quoteVisibleRangeLabel ? (
            <div>
              Photos show{" "}
              <span className="font-semibold text-primary-900">
                {quoteVisibleRangeLabel}
              </span>
              .
              {quoteMergedRangeLabel ? (
                <>
                  {" "}
                  This helped us price the job around{" "}
                  <span className="font-semibold text-primary-900">
                    {quoteMergedRangeLabel}
                  </span>
                  .
                </>
              ) : null}
            </div>
          ) : null}
          {quoteRangeWasWidened ? (
            <div>
              If there is more outside the photos, we&apos;ll review it in
              person before loading starts.
            </div>
          ) : null}
          {quoteState.addOnTotal > 0 && quoteAddOnSummary ? (
            <div>
              This estimate includes{" "}
              <span className="font-semibold text-primary-900">
                {quoteAddOnSummary}
              </span>
              .
            </div>
          ) : (
            <div>
              Special disposal items, like mattresses or paint cans, are added
              only if needed.
            </div>
          )}
          {quoteNeedsMorePhotos ? (
            <div>Want a tighter number? Add one more photo before booking.</div>
          ) : null}
        </div>
      ) : !isDemo ? (
        <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-600">
          Disposal add-ons apply only when needed, such as mattresses at +$40
          each and paint cans at +$10 each.
        </div>
      ) : null}
      <div className="text-sm font-medium text-neutral-700">
        {isDemo
          ? "This is a range. We'll confirm details on-site before we start."
          : "Your estimate is saved. Choose the next step below."}
      </div>

      {!showBookingDetails ? (
        <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm">
          <div className="text-lg font-semibold text-primary-900">
            Want to move forward?
          </div>
          <div className="grid gap-3">
            <Button
              type="button"
              className="justify-center"
              onClick={() => setShowBookingDetails(true)}
            >
              Book online
            </Button>
            <Button asChild variant="secondary" className="justify-center">
              <a
                href="tel:+14047772631"
                aria-label="Call to confirm and book"
                data-cta="book-call"
              >
                Call to confirm
              </a>
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="justify-center"
              onClick={() =>
                setTextEstimateMessage(
                  "Got it. We saved this estimate under your phone number for follow-up.",
                )
              }
            >
              Text me this estimate
            </Button>
          </div>
          {textEstimateMessage ? (
            <div className="text-xs text-emerald-700">
              {textEstimateMessage}
            </div>
          ) : null}
          <div className="text-[11px] text-neutral-500">
            If you call, we can pull up this estimate from your phone number.
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-white/80 bg-white/80 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-neutral-700">
              {isDemo ? "Book a demo estimate" : "Book this pickup"}
            </div>
            <button
              type="button"
              className="text-[11px] font-semibold text-primary-700 underline"
              onClick={() => setShowBookingDetails(false)}
            >
              Back to options
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              name="addressLine1"
              type="text"
              autoComplete="address-line1"
              placeholder="Street address"
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                name="city"
                type="text"
                autoComplete="address-level2"
                placeholder="City"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="col-span-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              />
              <input
                name="state"
                type="text"
                autoComplete="address-level1"
                placeholder="GA"
                maxLength={2}
                value={stateField}
                onChange={(e) => setStateField(e.target.value.toUpperCase())}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 uppercase"
              />
            </div>
            <input
              name="postalCode"
              type="text"
              autoComplete="postal-code"
              inputMode="numeric"
              placeholder="ZIP"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
            />
            <div className="space-y-2 rounded-md border border-neutral-200 bg-white p-3 md:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-neutral-700">
                  Choose a time
                </div>
                <button
                  type="button"
                  onClick={() => void fetchAvailability()}
                  disabled={
                    !addressComplete || availabilityStatus === "loading"
                  }
                  className="text-[11px] font-semibold text-primary-700 transition hover:text-primary-800 disabled:text-neutral-400"
                >
                  {availabilityStatus === "loading" ? "Checking..." : "Refresh"}
                </button>
              </div>
              {availabilityDurationMinutes ? (
                <div className="text-[11px] text-neutral-500">
                  Estimated job time: {availabilityDurationMinutes} min
                </div>
              ) : null}
              {!addressComplete ? (
                <div className="text-xs text-neutral-600">
                  Enter your address to see available times.
                </div>
              ) : availabilityStatus === "loading" ? (
                <div className="text-xs text-neutral-600">
                  Checking availability...
                </div>
              ) : availabilityStatus === "error" ? (
                <div className="text-xs text-amber-700">
                  {availabilityMessage ??
                    "Availability check failed. Please try again."}
                </div>
              ) : availabilitySlots.length ||
                availabilityDays.some((d) => d.slots.length > 0) ? (
                <div className="space-y-3">
                  {availabilitySlots.length ? (
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
                        Recommended times
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {availabilitySlots.map((slot) => {
                          const selected = slot.startAt === selectedSlotStartAt;
                          return (
                            <button
                              key={slot.startAt}
                              type="button"
                              onClick={() =>
                                setSelectedSlotStartAt(slot.startAt)
                              }
                              aria-pressed={selected}
                              className={cn(
                                "rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
                                selected
                                  ? "border-primary-900 bg-primary-800 shadow-soft ring-2 ring-primary-300"
                                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50",
                              )}
                            >
                              <div
                                className={cn(
                                  "text-sm font-semibold",
                                  selected ? "text-white" : "text-neutral-900",
                                )}
                              >
                                {formatSlotLabel(slot.startAt)}
                              </div>
                              <div
                                className={cn(
                                  "text-[11px]",
                                  selected
                                    ? "text-primary-100"
                                    : "text-neutral-600",
                                )}
                              >
                                {slot.reason}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {selectedSlotStartAt ? (
                    <div className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-900">
                      Selected time:{" "}
                      <span className="font-semibold">
                        {formatSlotLabel(selectedSlotStartAt)}
                      </span>
                    </div>
                  ) : null}
                  {holdStatus === "loading" ? (
                    <div className="text-[11px] text-neutral-500">
                      Holding that time for you...
                    </div>
                  ) : holdStatus === "ready" && holdExpiresAt ? (
                    <div className="text-[11px] text-neutral-500">
                      Held until {formatHoldExpiry(holdExpiresAt)}.
                    </div>
                  ) : holdStatus === "error" && holdMessage ? (
                    <div className="text-[11px] text-amber-700">
                      {holdMessage}
                    </div>
                  ) : null}

                  {(() => {
                    const availableDays = availabilityDays.filter(
                      (d) => d.slots.length > 0,
                    );
                    if (!availableDays.length) return null;
                    const selectedDay =
                      typeof availabilitySelectedDay === "string" &&
                      availabilitySelectedDay.length
                        ? availabilitySelectedDay
                        : (availableDays[0]?.date ?? null);
                    const selectedDaySlots = selectedDay
                      ? (availableDays.find((d) => d.date === selectedDay)
                          ?.slots ?? [])
                      : [];

                    return (
                      <div className="space-y-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-expanded={availabilityShowMore}
                          onClick={() =>
                            setAvailabilityShowMore((prev) => !prev)
                          }
                          className="w-full justify-center sm:w-auto"
                        >
                          {availabilityShowMore
                            ? "Hide more times"
                            : "See more times"}
                        </Button>

                        {availabilityShowMore ? (
                          <div className="space-y-2">
                            <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
                              Pick a day
                            </label>
                            <select
                              value={selectedDay ?? ""}
                              onChange={(e) => {
                                const next = e.target.value;
                                setAvailabilitySelectedDay(next);
                                const daySlots =
                                  availableDays.find((d) => d.date === next)
                                    ?.slots ?? [];
                                setSelectedSlotStartAt((prev) => {
                                  if (
                                    typeof prev === "string" &&
                                    daySlots.some((s) => s.startAt === prev)
                                  )
                                    return prev;
                                  return daySlots[0]?.startAt ?? null;
                                });
                              }}
                              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                            >
                              {availableDays.map((day) => (
                                <option key={day.date} value={day.date}>
                                  {formatDayLabel(day.date)}
                                </option>
                              ))}
                            </select>

                            {selectedDaySlots.length ? (
                              <div className="grid gap-2 sm:grid-cols-3">
                                {selectedDaySlots.map((slot) => {
                                  const selected =
                                    slot.startAt === selectedSlotStartAt;
                                  return (
                                    <button
                                      key={slot.startAt}
                                      type="button"
                                      onClick={() =>
                                        setSelectedSlotStartAt(slot.startAt)
                                      }
                                      aria-pressed={selected}
                                      className={cn(
                                        "rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
                                        selected
                                          ? "border-primary-900 bg-primary-800 shadow-soft ring-2 ring-primary-300"
                                          : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50",
                                      )}
                                      title={slot.reason}
                                    >
                                      <div
                                        className={cn(
                                          "text-sm font-semibold",
                                          selected
                                            ? "text-white"
                                            : "text-neutral-900",
                                        )}
                                      >
                                        {formatSlotTimeLabel(slot.startAt)}
                                      </div>
                                      <div
                                        className={cn(
                                          "truncate text-[11px]",
                                          selected
                                            ? "text-primary-100"
                                            : "text-neutral-600",
                                        )}
                                      >
                                        {slot.reason}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="text-xs text-neutral-600">
                                No times available on this day.
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-xs text-neutral-600">
                  {availabilityMessage ??
                    "No times available right now. Please call to confirm & book."}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              className="justify-center"
              onClick={() => void submitBooking()}
              disabled={
                bookingStatus === "loading" ||
                !selectedSlotStartAt ||
                availabilityStatus === "loading"
              }
            >
              {bookingStatus === "loading"
                ? "Booking..."
                : isDemo
                  ? "Book a demo estimate"
                  : "Book this pickup"}
            </Button>
            <Button asChild variant="secondary" className="justify-center">
              <a
                href="tel:+14047772631"
                aria-label="Call to confirm and book"
                data-cta="book-call"
              >
                Call to confirm &amp; book
              </a>
            </Button>
          </div>
          {bookingMessage ? (
            <div
              className={cn(
                "text-xs",
                bookingStatus === "error"
                  ? "text-amber-700"
                  : "text-emerald-700",
              )}
            >
              {bookingMessage}
            </div>
          ) : null}
          <div className="text-[11px] text-neutral-500">
            By booking, you agree to our{" "}
            <a
              href="/service-agreement"
              className="font-semibold text-primary-700 underline-offset-2 hover:underline"
            >
              Service Agreement and Cancellation Policy
            </a>
            . We&apos;ve saved your estimate with your contact info so we can
            help if you have questions.
          </div>
        </div>
      )}
    </div>
  );
}
