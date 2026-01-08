'use client';

import * as React from "react";
import { availabilityWindows } from "@myst-os/pricing";
import { Button, cn } from "@myst-os/ui";
import { Check } from "lucide-react";
import { DEFAULT_LEAD_SERVICE_OPTIONS } from "@/lib/lead-services";
import { useUTM } from "@/lib/use-utm";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

const SERVICE_OPTIONS = [
  ...DEFAULT_LEAD_SERVICE_OPTIONS,
  {
    slug: "commercial-services",
    title: "Commercial Services",
    description: "Storefronts, offices, HOAs, and shared spaces"
  }
];

function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function EstimateRequestForm({ className }: { className?: string }) {
  const utm = useUTM();
  const [services, setServices] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [addressLine1, setAddressLine1] = React.useState("");
  const [city, setCity] = React.useState("");
  const [stateField, setStateField] = React.useState("GA");
  const [postalCode, setPostalCode] = React.useState("");
  const [preferredDate, setPreferredDate] = React.useState("");
  const [timeWindow, setTimeWindow] = React.useState<string>("morning");
  const [alternateDate, setAlternateDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [hpCompany, setHpCompany] = React.useState("");
  const [submitState, setSubmitState] = React.useState<SubmitState>({ status: "idle" });

  const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"]?.replace(/\/$/, "") ?? "";
  const minDate = React.useMemo(() => todayIso(), []);

  const toggleService = (slug: string) => {
    setServices((prev) => (prev.includes(slug) ? prev.filter((entry) => entry !== slug) : [...prev, slug]));
  };

  const submit = async () => {
    if (!services.length) {
      setSubmitState({ status: "error", message: "Please select at least one service." });
      return;
    }
    if (!name.trim() || !phone.trim()) {
      setSubmitState({ status: "error", message: "Please enter your name and mobile number." });
      return;
    }
    if (!addressLine1.trim() || !city.trim() || !stateField.trim() || !postalCode.trim()) {
      setSubmitState({ status: "error", message: "Please enter the pickup address (street, city, state, ZIP)." });
      return;
    }
    if (!preferredDate.trim() || !timeWindow.trim()) {
      setSubmitState({ status: "error", message: "Please choose a preferred date and time window." });
      return;
    }

    setSubmitState({ status: "submitting" });

    try {
      const payload = {
        services,
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim().length ? email.trim() : undefined,
        addressLine1: addressLine1.trim(),
        city: city.trim(),
        state: stateField.trim().slice(0, 2).toUpperCase(),
        postalCode: postalCode.trim(),
        notes: notes.trim().length ? notes.trim() : undefined,
        scheduling: {
          preferredDate: preferredDate.trim(),
          alternateDate: alternateDate.trim().length ? alternateDate.trim() : undefined,
          timeWindow: timeWindow.trim()
        },
        appointmentType: "web_lead",
        utm,
        hp_company: hpCompany
      };

      const res = await fetch(`${apiBase}/api/web/lead-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; message?: string }
        | null;

      if (!res.ok) {
        const message =
          (typeof data?.message === "string" && data.message.trim().length > 0 ? data.message : null) ??
          (typeof data?.error === "string" && data.error.trim().length > 0 ? data.error : null) ??
          `Request failed (HTTP ${res.status})`;
        throw new Error(message);
      }

      if (data?.ok === false) {
        const message =
          (typeof data?.message === "string" && data.message.trim().length > 0 ? data.message : null) ??
          "We couldn’t submit your request. Please call or text us.";
        setSubmitState({ status: "error", message });
        return;
      }

      setSubmitState({
        status: "success",
        message: "Request received. We’ll follow up to confirm the exact time."
      });
    } catch (error) {
      setSubmitState({
        status: "error",
        message: error instanceof Error ? error.message : "We couldn’t submit your request. Please try again."
      });
    }
  };

  if (submitState.status === "success") {
    return (
      <div className={cn("rounded-2xl border border-neutral-200 bg-white p-6 shadow-soft", className)}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary-50 text-primary-800 ring-1 ring-primary-100">
            <Check className="h-5 w-5" strokeWidth={3} />
          </span>
          <div>
            <h2 className="font-display text-xl text-primary-900">You’re all set</h2>
            <p className="mt-1 text-sm text-neutral-600">{submitState.message}</p>
            <p className="mt-2 text-xs text-neutral-500">
              We’ll usually respond quickly by text/call. If you need help right now, call (404) 692-0768.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-2xl border border-neutral-200 bg-white p-6 shadow-soft", className)}>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Request a time window</p>
        <h2 className="font-display text-2xl text-primary-900">Schedule your estimate</h2>
        <p className="text-sm text-neutral-600">
          Pick a preferred date/time window and we’ll follow up to confirm. No obligation.
        </p>
      </div>

      {submitState.status === "error" ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          {submitState.message}
        </div>
      ) : null}

      <form
        className="mt-5 space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <p className="text-sm font-semibold text-neutral-800">What do you need removed?</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {SERVICE_OPTIONS.map((option) => {
              const selected = services.includes(option.slug);
              return (
                <button
                  key={option.slug}
                  type="button"
                  onClick={() => toggleService(option.slug)}
                  className={cn(
                    "group relative flex items-start gap-3 rounded-lg border p-3 text-left text-sm transition",
                    selected
                      ? "border-primary-600 bg-primary-50 shadow-sm ring-1 ring-primary-100"
                      : "border-neutral-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition",
                      selected
                        ? "border-primary-700 bg-white text-black"
                        : "border-neutral-300 bg-white text-transparent"
                    )}
                    aria-hidden="true"
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                  <span className="space-y-0.5">
                    <span className="block font-semibold text-neutral-900">{option.title}</span>
                    {option.description ? <span className="block text-xs text-neutral-500">{option.description}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

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
              autoComplete="name"
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
              autoComplete="tel"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-semibold text-neutral-800">Email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold text-neutral-800">Pickup address</p>
          <div className="grid gap-2">
            <input
              type="text"
              required
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              placeholder="Street address"
              autoComplete="street-address"
            />
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                type="text"
                required
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                placeholder="City"
                autoComplete="address-level2"
              />
              <input
                type="text"
                required
                maxLength={2}
                value={stateField}
                onChange={(e) => setStateField(e.target.value.toUpperCase())}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 uppercase"
                placeholder="GA"
                autoComplete="address-level1"
              />
              <input
                type="text"
                required
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
                placeholder="ZIP"
                autoComplete="postal-code"
              />
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold text-neutral-800">Preferred date & time</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">Preferred date</label>
              <input
                type="date"
                required
                min={minDate}
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">Time window</label>
              <select
                required
                value={timeWindow}
                onChange={(e) => setTimeWindow(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              >
                {availabilityWindows.map((window) => (
                  <option key={window.id} value={window.id}>
                    {window.label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-neutral-500">We’ll confirm a final time by text/call.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">Alternate date (optional)</label>
              <input
                type="date"
                min={minDate}
                value={alternateDate}
                onChange={(e) => setAlternateDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-neutral-800">Notes (optional)</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700"
            placeholder="Stairs, gate codes, heavy items, anything gross/unsafe to note, etc."
          />
        </div>

        <input
          type="text"
          value={hpCompany}
          onChange={(e) => setHpCompany(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button type="submit" disabled={submitState.status === "submitting"} className="w-full justify-center sm:w-auto">
            {submitState.status === "submitting" ? "Sending..." : "Request estimate"}
          </Button>
          <p className="text-xs text-neutral-500">
            Prefer to book by phone? Call <a className="font-semibold text-primary-700 hover:text-primary-800" href="tel:+14046920768">(404) 692-0768</a>.
          </p>
        </div>
      </form>
    </div>
  );
}

