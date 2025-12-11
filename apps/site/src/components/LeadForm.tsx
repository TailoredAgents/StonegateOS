'use client';

import * as React from "react";
import { Button, cn } from "@myst-os/ui";
import { useUTM } from "../lib/use-utm";

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
  { id: "few_items", label: "Just a few items", hint: "1–3 items" },
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
  const [timeframe, setTimeframe] = React.useState<Timeframe>("this_week");
  const [quoteState, setQuoteState] = React.useState<QuoteState>({ status: "idle" });
  const [error, setError] = React.useState<string | null>(null);
  const [addressLine1, setAddressLine1] = React.useState("");
  const [city, setCity] = React.useState("");
  const [stateField, setStateField] = React.useState("GA");
  const [postalCode, setPostalCode] = React.useState("");
  const [preferredDate, setPreferredDate] = React.useState("");
  const [timeWindow, setTimeWindow] = React.useState("");
  const [bookingStatus, setBookingStatus] = React.useState<"idle" | "loading" | "success" | "error">("idle");
  const [bookingMessage, setBookingMessage] = React.useState<string | null>(null);

  const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"]?.replace(/\/$/, "") ?? "";

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
  };

  const submitQuote = async () => {
    if (!name.trim() || !phone.trim() || !zip.trim()) {
      setError("Please fill name, phone, and ZIP.");
      return;
    }
    setError(null);
    setQuoteState({ status: "loading" });
    try {
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
      if (!res.ok) {
        throw new Error(`Quote failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as {
        ok?: boolean;
        quote?: {
          loadFractionEstimate: number;
          priceLow: number;
          priceHigh: number;
          priceLowDiscounted: number;
          priceHighDiscounted: number;
          displayTierLabel: string;
          reasonSummary: string;
          discountPercent?: number;
          needsInPersonEstimate?: boolean;
        };
      };
      if (!data.ok || !data.quote) throw new Error("Quote unavailable");
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

  const submitBooking = async () => {
    if (quoteState.status !== "ready") return;
    if (!addressLine1 || !city || !stateField || !postalCode) {
      setBookingStatus("error");
      setBookingMessage("Please enter address details.");
      return;
    }
    setBookingStatus("loading");
    setBookingMessage(null);
    try {
      const res = await fetch(`${apiBase}/api/junk-quote/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instantQuoteId: quoteState.quoteId,
          name: name.trim(),
          phone: phone.trim(),
          addressLine1,
          city,
          state: stateField,
          postalCode,
          preferredDate: preferredDate || null,
          timeWindow: timeWindow || null,
          notes: notes || null
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt.slice(0, 160));
      }
      setBookingStatus("success");
      setBookingMessage("Thanks! We saved your request. We’ll confirm your arrival window shortly.");
    } catch (err) {
      setBookingStatus("error");
      setBookingMessage((err as Error).message);
    }
  };

  const baseRange = quoteState.status === "ready" ? `$${quoteState.baseLow} – $${quoteState.baseHigh}` : null;
  const discountedRange =
    quoteState.status === "ready" ? `$${quoteState.low} – $${quoteState.high}` : null;

  return (
    <div className={cn("rounded-xl bg-white p-6 shadow-soft shadow-primary-900/10", className)} {...props}>
      <div className="mb-4 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
        <span className="rounded-full border border-neutral-200 px-3 py-1">Step {step} of 2</span>
        <span className="text-[10px] font-medium normal-case tracking-normal">Takes &lt; 1 minute. No spam.</span>
      </div>

      <h3 className="font-display text-2xl text-primary-800">Show us what you need gone</h3>
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
                  return (
                    <button
                      type="button"
                      key={opt.id}
                      onClick={() => toggleType(opt.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm",
                        selected ? "border-primary-500 bg-primary-50 text-primary-900" : "border-neutral-200 bg-white text-neutral-700"
                      )}
                    >
                      <span className={cn("h-3 w-3 rounded-full border", selected ? "bg-primary-500 border-primary-500" : "border-neutral-300")} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">Add 1–4 photos for the most accurate quote</label>
              <p className="text-xs text-neutral-500">Most people just snap a quick photo with their phone.</p>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => void handlePhotos(e.target.files)}
                className="block w-full cursor-pointer rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
              />
              <button
                type="button"
                className="text-xs text-primary-700 underline"
                onClick={() => setPhotos([])}
              >
                I can&apos;t add photos right now
              </button>
              {photos.length ? (
                <div className="flex flex-wrap gap-2 text-xs text-neutral-600">
                  {photos.map((_, idx) => (
                    <span key={idx} className="rounded-full bg-neutral-100 px-2 py-1">{`Photo ${idx + 1}`}</span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">How big does the job feel?</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {SIZE_OPTIONS.map((opt) => (
                  <label
                    key={opt.id}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3 text-sm",
                      perceivedSize === opt.id ? "border-primary-500 bg-primary-50" : "border-neutral-200 bg-white"
                    )}
                  >
                    <input
                      type="radio"
                      name="perceivedSize"
                      value={opt.id}
                      checked={perceivedSize === opt.id}
                      onChange={() => setPerceivedSize(opt.id)}
                      className="hidden"
                    />
                    <div className="font-semibold text-neutral-800">{opt.label}</div>
                    {opt.hint ? <div className="text-xs text-neutral-500">{opt.hint}</div> : null}
                  </label>
                ))}
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
              <p className="text-xs text-neutral-500">On the next step we’ll grab your name and number and show your quote on screen.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold text-neutral-800">Name</label>
                <input
                  type="text"
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
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                  placeholder="(404) 692-0768"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-neutral-800">How soon do you need this done?</label>
              <div className="grid gap-2 sm:grid-cols-4">
                {TIMEFRAME_OPTIONS.map((opt) => (
                  <label
                    key={opt.id}
                    className={cn(
                      "cursor-pointer rounded-lg border p-3 text-sm",
                      timeframe === opt.id ? "border-primary-500 bg-primary-50" : "border-neutral-200 bg-white"
                    )}
                  >
                    <input
                      type="radio"
                      name="timeframe"
                      value={opt.id}
                      checked={timeframe === opt.id}
                      onChange={() => setTimeframe(opt.id)}
                      className="hidden"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <Button type="submit" className="w-full justify-center" disabled={quoteState.status === "loading"}>
              {quoteState.status === "loading" ? "Calculating your quote..." : "Get my instant quote"}
            </Button>

            {quoteState.status === "ready" ? (
              <div className="space-y-3 rounded-xl border border-primary-200 bg-primary-50/70 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary-900">
                  <span className="rounded-full bg-primary-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                    15% off
                  </span>
                  Here&apos;s your instant quote
                </div>
                <div className="text-2xl font-semibold text-primary-900">
                  ${quoteState.low} – ${quoteState.high}
                  <span className="ml-2 text-sm font-normal text-neutral-500 line-through">
                    {quoteState.discountPercent > 0 ? baseRange : null}
                  </span>
                </div>
                <div className="text-sm text-neutral-700">{quoteState.tier}</div>
                <div className="text-xs text-neutral-600">{quoteState.reason}</div>
                <div className="text-xs text-neutral-600">
                  We&apos;ll confirm the exact price on-site before we start. If we use less space than expected, your price goes down.
                </div>
                <div className="space-y-3 rounded-lg border border-white/80 bg-white/80 p-3 text-sm">
                  <div className="text-xs font-semibold text-neutral-700">Book this pickup</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <input
                      type="text"
                      placeholder="Street address"
                      value={addressLine1}
                      onChange={(e) => setAddressLine1(e.target.value)}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="text"
                        placeholder="City"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        className="col-span-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                      />
                      <input
                        type="text"
                        placeholder="GA"
                        maxLength={2}
                        value={stateField}
                        onChange={(e) => setStateField(e.target.value.toUpperCase())}
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 uppercase"
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="ZIP"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        value={preferredDate}
                        onChange={(e) => setPreferredDate(e.target.value)}
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                      />
                      <input
                        type="text"
                        placeholder="Time window (e.g., 8-12)"
                        value={timeWindow}
                        onChange={(e) => setTimeWindow(e.target.value)}
                        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button type="button" className="justify-center" onClick={() => void submitBooking()} disabled={bookingStatus === "loading"}>
                      {bookingStatus === "loading" ? "Booking..." : "Book this pickup"}
                    </Button>
                    <a
                      href="tel:14046920768"
                      className="inline-flex items-center justify-center rounded-md border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700"
                    >
                      Call to confirm &amp; book
                    </a>
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
                    We’ve saved your quote with your contact info so we can help if you have questions.
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
              <p className="text-xs text-neutral-500">We’ll save this quote for follow-up.</p>
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
