'use client';

import * as React from "react";
import { Button, cn } from "@myst-os/ui";
import { Check } from "lucide-react";
import { useUTM } from "../lib/use-utm";
import { trackGoogleAdsConversion } from "../lib/google-ads";

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
  }
}

type QuoteState =
  | { status: "idle" | "loading" }
  | {
      status: "ready";
      quoteId: string | null;
      baseLow: number;
      baseHigh: number;
      discountPercent: number;
      low: number;
      high: number;
      tier: string;
      reason: string;
      needsInPersonEstimate: boolean;
    }
  | { status: "error"; message: string };

type AvailabilitySlot = { startAt: string; endAt: string; reason: string };
type AvailabilityDay = { date: string; slots: AvailabilitySlot[] };

type Timeframe = "today" | "tomorrow" | "this_week" | "flexible";
type PerceivedSize = "few_items" | "small_area" | "one_room_or_half_garage" | "big_cleanout" | "not_sure";
type JunkType =
  | "furniture"
  | "appliances"
  | "general_junk"
  | "yard_waste"
  | "construction_debris"
  | "hot_tub_playset"
  | "business_commercial";

const JUNK_OPTIONS: Array<{ id: JunkType; label: string }> = [
  { id: "furniture", label: "Furniture" },
  { id: "appliances", label: "Appliances" },
  { id: "general_junk", label: "General household junk" },
  { id: "yard_waste", label: "Yard waste / outdoor items" },
  { id: "construction_debris", label: "Construction / renovation debris" },
  { id: "hot_tub_playset", label: "Hot tub / playset" },
  { id: "business_commercial", label: "Business / commercial cleanout" }
];

const SIZE_OPTIONS: Array<{ id: PerceivedSize; label: string; hint: string }> = [
  { id: "few_items", label: "Just a few items", hint: "1-3 items" },
  { id: "small_area", label: "One small area", hint: "Corner, closet, or small pile" },
  { id: "one_room_or_half_garage", label: "One full room or half a garage", hint: "" },
  { id: "big_cleanout", label: "Big cleanout", hint: "Full garage, basement, or multiple rooms" },
  { id: "not_sure", label: "Not sure yet", hint: "" }
];

const TIMEFRAME_OPTIONS: Array<{ id: Timeframe; label: string }> = [
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "this_week", label: "This week" },
  { id: "flexible", label: "Flexible" }
];

const GOOGLE_ADS_CONTACT_SEND_TO = process.env["NEXT_PUBLIC_GOOGLE_ADS_CONTACT_SEND_TO"] ?? "";

export function LeadForm({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const utm = useUTM();
  const [step, setStep] = React.useState<1 | 2>(1);
  const [types, setTypes] = React.useState<JunkType[]>([]);
  const [perceivedSize, setPerceivedSize] = React.useState<PerceivedSize>("few_items");
  const [notes, setNotes] = React.useState("");
  const [zip, setZip] = React.useState("");
  const [photos, setPhotos] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [timeframe, setTimeframe] = React.useState<Timeframe>("this_week");
  const [quoteState, setQuoteState] = React.useState<QuoteState>({ status: "idle" });
  const [error, setError] = React.useState<string | null>(null);
  const [addressLine1, setAddressLine1] = React.useState("");
  const [city, setCity] = React.useState("");
  const [stateField, setStateField] = React.useState("GA");
  const [postalCode, setPostalCode] = React.useState("");
  const [availabilityStatus, setAvailabilityStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [availabilityMessage, setAvailabilityMessage] = React.useState<string | null>(null);
  const [availabilityTimezone, setAvailabilityTimezone] = React.useState("America/New_York");
  const [availabilityDurationMinutes, setAvailabilityDurationMinutes] = React.useState<number | null>(null);
  const [availabilitySlots, setAvailabilitySlots] = React.useState<AvailabilitySlot[]>([]);
  const [availabilityDays, setAvailabilityDays] = React.useState<AvailabilityDay[]>([]);
  const [availabilityShowMore, setAvailabilityShowMore] = React.useState(false);
  const [availabilitySelectedDay, setAvailabilitySelectedDay] = React.useState<string | null>(null);
  const [selectedSlotStartAt, setSelectedSlotStartAt] = React.useState<string | null>(null);
  const selectedSlotStartAtRef = React.useRef<string | null>(null);
  const [holdId, setHoldId] = React.useState<string | null>(null);
  const [holdExpiresAt, setHoldExpiresAt] = React.useState<string | null>(null);
  const [holdStatus, setHoldStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [holdMessage, setHoldMessage] = React.useState<string | null>(null);
  const holdSlotRef = React.useRef<string | null>(null);
  const holdRequestRef = React.useRef(0);
  const holdInFlightRef = React.useRef<string | null>(null);
  const [bookingStatus, setBookingStatus] = React.useState<"idle" | "loading" | "success" | "error">("idle");
  const [bookingMessage, setBookingMessage] = React.useState<string | null>(null);
  const [photoSkipped, setPhotoSkipped] = React.useState(false);
  const trackedScheduleRef = React.useRef(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const quoteCardRef = React.useRef<HTMLDivElement | null>(null);
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);
  const prevStepRef = React.useRef<1 | 2 | null>(null);
  const prevQuoteStatusRef = React.useRef<QuoteState["status"] | null>(null);

  const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"]?.replace(/\/$/, "") ?? "";
  const quoteId = quoteState.status === "ready" ? quoteState.quoteId : null;
  const addressComplete =
    addressLine1.trim().length >= 5 &&
    city.trim().length >= 2 &&
    stateField.trim().length === 2 &&
    postalCode.trim().length >= 3;

  React.useEffect(() => {
    selectedSlotStartAtRef.current = selectedSlotStartAt;
  }, [selectedSlotStartAt]);

  const prefersReducedMotion = React.useCallback(() => {
    if (typeof window === "undefined") return false;
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const scrollToElement = React.useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
      try {
        el.scrollIntoView({ behavior, block: "start" });
      } catch {
        el.scrollIntoView();
      }
    },
    [prefersReducedMotion]
  );

  React.useEffect(() => {
    const previousStep = prevStepRef.current;
    prevStepRef.current = step;
    if (previousStep === null) return;
    if (previousStep === step) return;

    scrollToElement(containerRef.current);

    if (step === 2) {
      window.setTimeout(() => {
        nameInputRef.current?.focus();
      }, prefersReducedMotion() ? 0 : 100);
    }
  }, [prefersReducedMotion, scrollToElement, step]);

  React.useEffect(() => {
    const previousStatus = prevQuoteStatusRef.current;
    prevQuoteStatusRef.current = quoteState.status;
    if (previousStatus === null) return;
    if (previousStatus !== "ready" && quoteState.status === "ready" && step === 2) {
      window.setTimeout(() => {
        scrollToElement(quoteCardRef.current);
      }, prefersReducedMotion() ? 0 : 100);
    }
  }, [prefersReducedMotion, quoteState.status, scrollToElement, step]);

  const trackMetaEvent = React.useCallback((eventName: string, params?: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    if (typeof window.fbq !== "function") return;
    try {
      window.fbq("track", eventName, params ?? {});
    } catch {
      // ignore
    }
  }, []);

  const trackGoogleContactConversion = React.useCallback(() => {
    if (!GOOGLE_ADS_CONTACT_SEND_TO) return;
    trackGoogleAdsConversion(GOOGLE_ADS_CONTACT_SEND_TO, { value: 1, currency: "USD" });
  }, []);

  const formatSlotLabel = React.useCallback(
    (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: availabilityTimezone
      }).format(date);
    },
    [availabilityTimezone]
  );

  const formatSlotTimeLabel = React.useCallback(
    (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: availabilityTimezone
      }).format(date);
    },
    [availabilityTimezone]
  );

  const formatHoldExpiry = React.useCallback(
    (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: availabilityTimezone
      }).format(date);
    },
    [availabilityTimezone]
  );

  const formatDayLabel = React.useCallback(
    (dayIso: string) => {
      const date = new Date(`${dayIso}T12:00:00Z`);
      if (Number.isNaN(date.getTime())) return dayIso;
      return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: availabilityTimezone
      }).format(date);
    },
    [availabilityTimezone]
  );

  const toggleType = (id: JunkType) => {
    setTypes((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const handlePhotos = async (files: FileList | null) => {
    if (!files) return;
    const selected = Array.from(files).slice(0, 4);
    const dataUrls: string[] = [];
    for (const file of selected) {
      const url = await toDataUrl(file);
      if (url) dataUrls.push(url);
    }
    setPhotos(dataUrls);
    setPhotoSkipped(false);
  };

  const submitQuote = async () => {
    if (!name.trim() || !phone.trim() || !zip.trim()) {
      setError("Please fill name, phone, and ZIP.");
      return;
    }
    setError(null);
    setQuoteState({ status: "loading" });
    try {
      if (!types.length) {
        setStep(1);
        setQuoteState({ status: "idle" });
        setError("Pick at least one type of junk.");
        return;
      }
      const res = await fetch(`${apiBase}/api/junk-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "public_site",
          contact: { name: name.trim(), phone: phone.trim(), timeframe },
          job: {
            types,
            perceivedSize,
            notes: notes.trim() || undefined,
            zip: zip.trim(),
            photoUrls: photos
          },
          utm
        })
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        quoteId?: string | null;
        quote?: {
          loadFractionEstimate: number;
          priceLow: number;
          priceHigh: number;
          priceLowDiscounted?: number;
          priceHighDiscounted?: number;
          displayTierLabel: string;
          reasonSummary: string;
          discountPercent?: number;
          needsInPersonEstimate?: boolean;
        };
      } | null;
      if (!res.ok || !data?.ok) {
        const message =
          (typeof data?.message === "string" && data.message.trim().length > 0
            ? data.message
            : typeof data?.error === "string" && data.error.trim().length > 0
              ? data.error
              : null) ?? `Quote failed (HTTP ${res.status})`;
        throw new Error(message);
      }
      if (!data.quote) throw new Error("Quote unavailable");
      setQuoteState({
        status: "ready",
        quoteId: data.quoteId ?? null,
        baseLow: data.quote.priceLow,
        baseHigh: data.quote.priceHigh,
        low: data.quote.priceLowDiscounted ?? data.quote.priceLow,
        high: data.quote.priceHighDiscounted ?? data.quote.priceHigh,
        discountPercent: data.quote.discountPercent ?? 0,
        tier: data.quote.displayTierLabel,
        reason: data.quote.reasonSummary,
        needsInPersonEstimate: Boolean(data.quote.needsInPersonEstimate)
      });
    } catch (err) {
      setQuoteState({ status: "error", message: (err as Error).message });
    }
  };

  const fetchAvailability = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!quoteId || !addressComplete) return;
      setAvailabilityStatus("loading");
      setAvailabilityMessage(null);
      try {
        const selectedSlotAtRequestStart = selectedSlotStartAtRef.current;
        const res = await fetch(`${apiBase}/api/junk-quote/availability`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instantQuoteId: quoteId,
            addressLine1: addressLine1.trim(),
            city: city.trim(),
            state: stateField.trim(),
            postalCode: postalCode.trim()
          }),
          signal
        });
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              timezone?: string;
              durationMinutes?: number;
              suggestions?: AvailabilitySlot[];
              days?: AvailabilityDay[];
              error?: string;
              message?: string;
            }
          | null;

        if (!res.ok || !data?.ok) {
          const message =
            typeof data?.message === "string" && data.message.trim().length > 0
              ? data.message
              : typeof data?.error === "string"
                ? data.error
                : `Availability failed (HTTP ${res.status})`;
          setAvailabilityStatus("error");
          setAvailabilityMessage(message);
          setAvailabilitySlots([]);
          setAvailabilityDays([]);
          setAvailabilitySelectedDay(null);
          setSelectedSlotStartAt(null);
          return;
        }

        const tz = typeof data.timezone === "string" && data.timezone.length ? data.timezone : "America/New_York";
        const duration = typeof data.durationMinutes === "number" && Number.isFinite(data.durationMinutes) ? data.durationMinutes : null;
        const slots = Array.isArray(data.suggestions) ? data.suggestions : [];
        const days = Array.isArray(data.days) ? data.days : [];
        const allSlots = slots.concat(days.flatMap((d) => (Array.isArray(d.slots) ? d.slots : [])));

        setAvailabilityTimezone(tz);
        setAvailabilityDurationMinutes(duration);
        setAvailabilitySlots(slots);
        setAvailabilityDays(days);
        setAvailabilityStatus("ready");
        setSelectedSlotStartAt((prev) => {
          if (typeof prev === "string" && allSlots.some((s) => s.startAt === prev)) return prev;
          return slots[0]?.startAt ?? allSlots[0]?.startAt ?? null;
        });
        setAvailabilitySelectedDay((prev) => {
          const availableDays = days.filter((d) => Array.isArray(d.slots) && d.slots.length > 0);
          if (!availableDays.length) return null;
          if (typeof prev === "string" && availableDays.some((d) => d.date === prev)) return prev;
          const bySelectedSlot =
            typeof selectedSlotAtRequestStart === "string"
              ? availableDays.find((d) => d.slots.some((s) => s.startAt === selectedSlotAtRequestStart))
              : null;
          return bySelectedSlot?.date ?? availableDays[0]?.date ?? null;
        });
        setAvailabilityMessage(
          allSlots.length
            ? null
            : "No times available in the next two weeks. Please call to confirm & book."
        );
      } catch (err) {
        if ((err as any)?.name === "AbortError") return;
        setAvailabilityStatus("error");
        setAvailabilityMessage("Availability check failed. Please try again.");
        setAvailabilitySlots([]);
        setAvailabilityDays([]);
        setAvailabilitySelectedDay(null);
        setSelectedSlotStartAt(null);
      }
    },
    [addressComplete, addressLine1, apiBase, city, postalCode, quoteId, stateField]
  );

  React.useEffect(() => {
    if (step !== 2 || !quoteId || !addressComplete) {
      setAvailabilityStatus("idle");
      setAvailabilitySlots([]);
      setAvailabilityDays([]);
      setAvailabilityShowMore(false);
      setAvailabilitySelectedDay(null);
      setSelectedSlotStartAt(null);
      setAvailabilityMessage(null);
      setHoldId(null);
      setHoldExpiresAt(null);
      setHoldStatus("idle");
      setHoldMessage(null);
      holdSlotRef.current = null;
      holdInFlightRef.current = null;
      return;
    }

    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      void fetchAvailability(controller.signal);
    }, 450);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [addressComplete, fetchAvailability, quoteId, step]);

  React.useEffect(() => {
    if (
      step !== 2 ||
      availabilityStatus !== "ready" ||
      !quoteId ||
      !addressComplete ||
      !selectedSlotStartAt
    ) {
      return;
    }

    if (holdSlotRef.current === selectedSlotStartAt && holdId) return;
    if (holdInFlightRef.current === selectedSlotStartAt) return;

    const slotStartAt = selectedSlotStartAt;
    const controller = new AbortController();
    const requestId = ++holdRequestRef.current;
    holdInFlightRef.current = slotStartAt;
    setHoldStatus("loading");
    setHoldMessage(null);

    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/junk-quote/hold`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instantQuoteId: quoteId,
            startAt: slotStartAt,
            addressLine1: addressLine1.trim(),
            city: city.trim(),
            state: stateField.trim(),
            postalCode: postalCode.trim()
          }),
          signal: controller.signal
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; holdId?: string; expiresAt?: string; error?: string; message?: string }
          | null;

        if (requestId !== holdRequestRef.current) return;

        if (!res.ok || !data?.ok) {
          const error =
            typeof data?.error === "string" && data.error.length
              ? data.error
              : `Hold failed (HTTP ${res.status})`;
          const message =
            typeof (data as { message?: string } | null)?.message === "string" &&
            (data as { message?: string }).message!.trim().length > 0
              ? (data as { message?: string }).message!
              : error === "slot_full"
                ? "That time just filled up. Please pick another time."
                : error === "day_full"
                  ? "We are fully booked that day. Please choose another time."
                  : error === "outside_booking_window"
                    ? "That time is outside our booking window. Please pick another time."
                    : error;
          setHoldStatus("error");
          setHoldMessage(message);
          setHoldId(null);
          setHoldExpiresAt(null);
          holdSlotRef.current = null;
          if (error === "slot_full" || error === "day_full") {
            void fetchAvailability();
          }
          return;
        }

        setHoldId(data.holdId ?? null);
        setHoldExpiresAt(data.expiresAt ?? null);
        setHoldStatus("ready");
        setHoldMessage(null);
        holdSlotRef.current = slotStartAt;
      } catch (err) {
        if ((err as any)?.name === "AbortError") return;
        if (requestId !== holdRequestRef.current) return;
        setHoldStatus("error");
        setHoldMessage("We couldn't hold that time. Please try again.");
        setHoldId(null);
        setHoldExpiresAt(null);
        holdSlotRef.current = null;
      } finally {
        if (requestId === holdRequestRef.current) {
          holdInFlightRef.current = null;
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    addressComplete,
    addressLine1,
    apiBase,
    availabilityStatus,
    city,
    fetchAvailability,
    holdId,
    postalCode,
    quoteId,
    selectedSlotStartAt,
    stateField,
    step
  ]);

  const submitBooking = async () => {
    if (quoteState.status !== "ready") return;
    if (!quoteId) {
      setBookingStatus("error");
      setBookingMessage("Quote is missing. Please refresh and try again.");
      return;
    }
    if (!addressLine1 || !city || !stateField || !postalCode) {
      setBookingStatus("error");
      setBookingMessage("Please enter address details.");
      return;
    }
    if (!selectedSlotStartAt) {
      setBookingStatus("error");
      setBookingMessage("Please choose an available time.");
      return;
    }
    setBookingStatus("loading");
    setBookingMessage(null);
    try {
      const payload: Record<string, unknown> = {
        instantQuoteId: quoteId,
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim().length ? email.trim() : null,
        addressLine1: addressLine1.trim(),
        city: city.trim(),
        state: stateField.trim(),
        postalCode: postalCode.trim(),
        startAt: selectedSlotStartAt,
        notes: notes || null
      };
      if (holdId) payload["holdId"] = holdId;

      const res = await fetch(`${apiBase}/api/junk-quote/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
       });
      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as
          | { error?: string; errorId?: string; message?: string }
          | null;
        if (errorPayload?.error === "slot_full") {
          setBookingStatus("error");
          setBookingMessage("That time just filled up. Please pick another time.");
          void fetchAvailability();
          return;
        }
        if (errorPayload?.error === "day_full") {
          setBookingStatus("error");
          setBookingMessage("We are fully booked that day. Please choose another time.");
          void fetchAvailability();
          return;
        }
        if (
          errorPayload?.error === "hold_expired" ||
          errorPayload?.error === "hold_not_found" ||
          errorPayload?.error === "hold_mismatch"
        ) {
          setBookingStatus("error");
          setBookingMessage("That hold expired. Please pick another time.");
          setHoldId(null);
          setHoldExpiresAt(null);
          setHoldStatus("idle");
          holdSlotRef.current = null;
          void fetchAvailability();
          return;
        }
        if (errorPayload?.error === "server_error") {
          const suffix =
            typeof errorPayload.errorId === "string" && errorPayload.errorId.length
              ? ` (ref ${errorPayload.errorId})`
              : "";
          throw new Error(`Booking failed on our end. Please try again or call us.${suffix}`);
        }
        if (typeof errorPayload?.message === "string" && errorPayload.message.trim().length > 0) {
          throw new Error(errorPayload.message);
        }
        const message =
          typeof errorPayload?.error === "string" && errorPayload.error.length
            ? errorPayload.error
            : `Booking failed (HTTP ${res.status})`;
        throw new Error(message);
      }
      const data = (await res.json().catch(() => null)) as { startAt?: string | null } | null;
      const bookedAt = typeof data?.startAt === "string" && data.startAt.length ? data.startAt : selectedSlotStartAt;
      setBookingStatus("success");
      setBookingMessage(
        `You're booked for ${formatSlotLabel(bookedAt)}. We'll text${email.trim().length ? " (and email)" : ""} you a confirmation.`
      );
      setHoldStatus("idle");
      if (!trackedScheduleRef.current) {
        trackedScheduleRef.current = true;
        trackMetaEvent("Schedule", { content_name: "Book pickup", content_category: "junk_removal" });
        trackGoogleContactConversion();
      }
    } catch (err) {
      setBookingStatus("error");
      setBookingMessage((err as Error).message);
    }
  };

  const baseRange =
    quoteState.status === "ready"
      ? quoteState.baseLow === quoteState.baseHigh
        ? `$${quoteState.baseLow}`
        : `$${quoteState.baseLow} - $${quoteState.baseHigh}`
      : null;
  const discountedRange =
    quoteState.status === "ready"
      ? quoteState.low === quoteState.high
        ? `$${quoteState.low}`
        : `$${quoteState.low} - $${quoteState.high}`
      : null;

  return (
    <div
      ref={containerRef}
      className={cn("scroll-mt-24 rounded-xl bg-white p-6 shadow-soft shadow-primary-900/10", className)}
      {...props}
    >
      <div className="mb-4 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
        <span className="rounded-full border border-neutral-200 px-3 py-1">Step {step} of 2</span>
        <span className="text-[10px] font-medium normal-case tracking-normal">Takes &lt; 1 minute. No spam.</span>
      </div>

      <h2 className="font-display text-2xl text-primary-800">Show us what you need gone</h2>
      <p className="mt-1 text-sm text-neutral-600">Photos + a few quick answers = an instant quote.</p>

      {error ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          {error}
        </div>
      ) : null}

      <form
        className="mt-4 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 1) {
            setStep(2);
          } else {
            void submitQuote();
          }
        }}
      >
        {step === 1 ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-semibold text-neutral-800">What type of stuff is it?</label>
              <p className="text-xs text-neutral-500">Choose all that apply</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {JUNK_OPTIONS.map((opt) => {
                  const selected = types.includes(opt.id);
                  const checkboxId = `junk-type-${opt.id}`;
                  return (
                    <label
                      key={opt.id}
                      htmlFor={checkboxId}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition",
                        selected ? "border-primary-600 bg-primary-50 text-primary-900 shadow-sm" : "border-neutral-200 bg-white text-neutral-700"
                      )}
                    >
                      <input
                        id={checkboxId}
                        type="checkbox"
                        className="sr-only"
                        checked={selected}
                        onChange={() => toggleType(opt.id)}
                        aria-label={opt.label}
                      />
                      <span
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition",
                          selected ? "border-primary-700 bg-white text-black" : "border-neutral-300 bg-white text-transparent"
                        )}
                        aria-hidden="true"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      </span>
                      <span>{opt.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="lead-photos" className="text-sm font-semibold text-neutral-800">
                Add 1-4 photos for the most accurate quote
              </label>
              <p className="text-xs text-neutral-500">Most people just snap a quick photo with their phone.</p>
              <input
                id="lead-photos"
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => void handlePhotos(e.target.files)}
                className="block w-full cursor-pointer rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
              />
              <button
                type="button"
                className="text-xs text-primary-700 underline"
                onClick={() => {
                  setPhotos([]);
                  setPhotoSkipped(true);
                }}
              >
                I can&apos;t add photos right now
              </button>
              {photos.length ? (
                <div className="flex flex-wrap gap-2 text-xs text-neutral-600">
                  {photos.map((_, idx) => (
                    <span key={idx} className="rounded-full bg-neutral-100 px-2 py-1">{`Photo ${idx + 1}`}</span>
                  ))}
                </div>
              ) : photoSkipped ? (
                <div className="text-xs text-neutral-600">No photos added (you can still continue).</div>
              ) : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">How big does the job feel?</label>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How big does the job feel?">
                {SIZE_OPTIONS.map((opt) => {
                  const selected = perceivedSize === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPerceivedSize(opt.id)}
                      className={cn(
                        "group relative flex items-start gap-3 rounded-lg border p-3 text-sm transition",
                        selected
                          ? "border-primary-600 bg-primary-50 shadow-sm ring-1 ring-primary-100"
                          : "border-neutral-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition",
                          selected ? "border-primary-700 bg-white text-black" : "border-neutral-300 bg-white text-transparent"
                        )}
                        aria-hidden="true"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      </span>
                      <div className="space-y-0.5">
                        <div className="font-semibold text-neutral-900">{opt.label}</div>
                        {opt.hint ? <div className="text-xs text-neutral-500">{opt.hint}</div> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">Anything else we should know?</label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                placeholder="Gate codes, stairs, heavy items, etc."
              />
            </div>

              <div className="space-y-1">
                <label className="text-sm font-semibold text-neutral-800">Job ZIP code</label>
                <input
                  type="text"
                  autoComplete="postal-code"
                  inputMode="numeric"
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  required
                  placeholder="30189"
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button type="submit" className="w-full justify-center sm:w-auto">
                Next: Your details
              </Button>
              <p className="text-xs text-neutral-500">On the next step we'll grab your name and number and show your quote on screen.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold text-neutral-800">Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                  placeholder="Jamie Customer"
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-neutral-800">Mobile number</label>
                <input
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                  placeholder="(404) 777-2631"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-sm font-semibold text-neutral-800">Email (optional)</label>
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">How soon do you need this done?</label>
              <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="How soon do you need this done?">
                {TIMEFRAME_OPTIONS.map((opt) => {
                  const selected = timeframe === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setTimeframe(opt.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                        selected
                          ? "border-primary-600 bg-primary-50 shadow-sm ring-1 ring-primary-100"
                          : "border-neutral-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-semibold transition",
                          selected ? "border-primary-700 bg-white text-black" : "border-neutral-300 bg-white text-transparent"
                        )}
                        aria-hidden="true"
                      >
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                      <span className="font-semibold text-neutral-900">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Button type="submit" className="w-full justify-center" disabled={quoteState.status === "loading"}>
              {quoteState.status === "loading" ? "Calculating your quote..." : "Get my instant quote"}
            </Button>

            {quoteState.status === "ready" ? (
              <div ref={quoteCardRef} className="space-y-3 rounded-xl border border-primary-200 bg-primary-50/70 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary-900">
                  {quoteState.discountPercent > 0 ? (
                    <span className="rounded-full bg-primary-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                      {Math.round(quoteState.discountPercent * 100)}% off
                    </span>
                  ) : null}
                  Here&apos;s your instant quote
                </div>
                <div className="text-2xl font-semibold text-primary-900">
                  {discountedRange}
                  <span className="ml-2 text-sm font-normal text-neutral-500 line-through">
                    {quoteState.discountPercent > 0 ? baseRange : null}
                  </span>
                </div>
                <div className="text-sm text-neutral-700">{quoteState.tier}</div>
                <div className="text-xs text-neutral-600">{quoteState.reason}</div>
                <div className="text-xs text-neutral-600">
                  Disposal fees may apply for certain items (for example, mattresses/box springs are +$40 each).
                </div>
                <div className="text-xs text-neutral-600">
                  We&apos;ll confirm the exact price on-site before we start. If we use less space than expected, your price goes down.
                </div>
                  <div className="space-y-3 rounded-lg border border-white/80 bg-white/80 p-3 text-sm">
                    <div className="text-xs font-semibold text-neutral-700">Book this pickup</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <input
                        type="text"
                        autoComplete="street-address"
                        placeholder="Street address"
                        value={addressLine1}
                        onChange={(e) => setAddressLine1(e.target.value)}
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          autoComplete="address-level2"
                          placeholder="City"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          className="col-span-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                        />
                        <input
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
                        type="text"
                        autoComplete="postal-code"
                        inputMode="numeric"
                        placeholder="ZIP"
                        value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value)}
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                      />
                    <div className="md:col-span-2 space-y-2 rounded-md border border-neutral-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-neutral-700">Choose a time</div>
                        <button
                          type="button"
                          onClick={() => void fetchAvailability()}
                          disabled={!addressComplete || availabilityStatus === "loading"}
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
                        <div className="text-xs text-neutral-600">Checking availability...</div>
                      ) : availabilityStatus === "error" ? (
                        <div className="text-xs text-amber-700">
                          {availabilityMessage ?? "Availability check failed. Please try again."}
                        </div>
                      ) : availabilitySlots.length || availabilityDays.some((d) => d.slots.length > 0) ? (
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
                                      onClick={() => setSelectedSlotStartAt(slot.startAt)}
                                      aria-pressed={selected}
                                      className={cn(
                                        "rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
                                        selected
                                          ? "border-primary-900 bg-primary-800 shadow-soft ring-2 ring-primary-300"
                                          : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                                      )}
                                    >
                                      <div
                                        className={cn(
                                          "text-sm font-semibold",
                                          selected ? "text-white" : "text-neutral-900"
                                        )}
                                      >
                                        {formatSlotLabel(slot.startAt)}
                                      </div>
                                      <div
                                        className={cn(
                                          "text-[11px]",
                                          selected ? "text-primary-100" : "text-neutral-600"
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
                              Selected time: <span className="font-semibold">{formatSlotLabel(selectedSlotStartAt)}</span>
                            </div>
                          ) : null}
                          {holdStatus === "loading" ? (
                            <div className="text-[11px] text-neutral-500">Holding that time for you...</div>
                          ) : holdStatus === "ready" && holdExpiresAt ? (
                            <div className="text-[11px] text-neutral-500">
                              Held until {formatHoldExpiry(holdExpiresAt)}.
                            </div>
                          ) : holdStatus === "error" && holdMessage ? (
                            <div className="text-[11px] text-amber-700">{holdMessage}</div>
                          ) : null}

                          {(() => {
                            const availableDays = availabilityDays.filter((d) => d.slots.length > 0);
                            if (!availableDays.length) return null;

                            const selectedDay =
                              typeof availabilitySelectedDay === "string" && availabilitySelectedDay.length
                                ? availabilitySelectedDay
                                : availableDays[0]?.date ?? null;
                            const selectedDaySlots =
                              selectedDay ? availableDays.find((d) => d.date === selectedDay)?.slots ?? [] : [];

                            return (
                              <div className="space-y-2">
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  aria-expanded={availabilityShowMore}
                                  onClick={() => setAvailabilityShowMore((prev) => !prev)}
                                  className="w-full justify-center sm:w-auto"
                                >
                                  {availabilityShowMore ? "Hide more times" : "See more times"}
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
                                        const daySlots = availableDays.find((d) => d.date === next)?.slots ?? [];
                                        setSelectedSlotStartAt((prev) => {
                                          if (typeof prev === "string" && daySlots.some((s) => s.startAt === prev)) return prev;
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
                                          const selected = slot.startAt === selectedSlotStartAt;
                                          return (
                                            <button
                                              key={slot.startAt}
                                              type="button"
                                              onClick={() => setSelectedSlotStartAt(slot.startAt)}
                                              aria-pressed={selected}
                                              className={cn(
                                                "rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
                                                selected
                                                  ? "border-primary-900 bg-primary-800 shadow-soft ring-2 ring-primary-300"
                                                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                                              )}
                                              title={slot.reason}
                                            >
                                              <div
                                                className={cn(
                                                  "text-sm font-semibold",
                                                  selected ? "text-white" : "text-neutral-900"
                                                )}
                                              >
                                                {formatSlotTimeLabel(slot.startAt)}
                                              </div>
                                              <div
                                                className={cn(
                                                  "truncate text-[11px]",
                                                  selected ? "text-primary-100" : "text-neutral-600"
                                                )}
                                              >
                                                {slot.reason}
                                              </div>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-neutral-600">No times available on this day.</div>
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div className="text-xs text-neutral-600">
                          {availabilityMessage ?? "No times available right now. Please call to confirm & book."}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      className="justify-center"
                      onClick={() => void submitBooking()}
                      disabled={bookingStatus === "loading" || !selectedSlotStartAt || availabilityStatus === "loading"}
                    >
                      {bookingStatus === "loading" ? "Booking..." : "Book this pickup"}
                    </Button>
                    <Button asChild variant="secondary" className="justify-center">
                      <a href="tel:+14047772631" aria-label="Call to confirm and book">
                        Call to confirm &amp; book
                      </a>
                    </Button>
                  </div>
                  {bookingMessage ? (
                    <div
                      className={cn(
                        "text-xs",
                        bookingStatus === "error" ? "text-amber-700" : "text-emerald-700"
                      )}
                    >
                      {bookingMessage}
                    </div>
                  ) : null}
                  <div className="text-[11px] text-neutral-500">
                    We've saved your quote with your contact info so we can help if you have questions.
                  </div>
                </div>
              </div>
            ) : quoteState.status === "error" ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {quoteState.message}
              </div>
            ) : null}

            <div className="flex items-center justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <p className="text-xs text-neutral-500">We'll save this quote for follow-up.</p>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

async function toDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
